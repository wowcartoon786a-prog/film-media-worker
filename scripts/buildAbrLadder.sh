#!/usr/bin/env bash
set -euo pipefail

# film-media-worker/scripts/buildAbrLadder.sh
#
# Builds a multi-resolution, multi-audio HLS ladder from ./master.mp4
# (already downloaded by the calling workflow step) into ./output/.
# Called by .github/workflows/abr-transcode.yml — kept as its own script
# rather than an inline `run:` block because the ffmpeg command it builds
# is genuinely dynamic (1-3 resolution rungs, 0-N audio tracks, 0-N
# subtitle tracks) and would be unreadable embedded directly in YAML.
#
# Writes ./output/manifest-info.json describing what was actually
# produced (resolution rungs + detected audio tracks + detected subtitle
# tracks). The calling workflow reads this afterward to build the
# callback payload, once it also knows the final storage keys and
# segment counts — this script doesn't need to know anything about
# storage or the film's Mongo _id at all, keeping it independently
# testable.
#
# Every resolution rung, including the top one, is freshly re-encoded —
# never a stream-copy of the source, even for the highest rung. Adaptive
# switching between rungs depends on matched keyframe/GOP alignment
# across every rendition, which a raw copy of the source can't
# guarantee — the -g/-keyint_min/-sc_threshold flags below keep every
# rung's keyframe interval consistent so switching is actually seamless.
#
# Resolution/audio handling is unified, not split into separate
# single-audio-vs-multi-audio code paths — a single-audio source is just
# the N=1 case of the same audio-mapping loop used for multi-audio
# sources, so there's no need for a real branch between them.
#
# SILENT SOURCES: a source with zero audio streams is a real, expected
# case for this app, not an error — its own category taxonomy includes
# "Silent Film", and general home-movie/archive.org content genuinely
# has none sometimes (confirmed in practice: an early version of this
# script hard-failed on exactly this case for a real 1947 home movie).
# When AUDIO_COUNT is 0, this script produces a video-only HLS ladder —
# a standard, fully valid HLS shape (variant streams with no attached
# EXT-X-MEDIA audio group) — rather than exiting with an error.
#
# SLICE 16 — SUBTITLES: purely extraction of embedded subtitle streams
# the source ALREADY carries (common in MKV rips) — no transcription, no
# AI generation, no new tool or model. Only text-based subtitle codecs
# (subrip/ass/ssa/mov_text/webvtt) can be converted to WebVTT at all;
# bitmap-based codecs (PGS from Blu-ray rips, VobSub/dvd_subtitle from
# DVD rips) are images, not text, and are skipped cleanly — logged, never
# treated as a failure. A source with no usable embedded subtitles
# produces byte-for-byte the same master.m3u8 as before this slice; the
# manifest is only patched with #EXT-X-MEDIA:TYPE=SUBTITLES entries when
# at least one qualifying track was actually extracted.

INPUT="master.mp4"
OUTPUT_DIR="output"
mkdir -p "$OUTPUT_DIR"

# --- Probe source resolution ---
SRC_HEIGHT=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$INPUT")

# --- Decide the resolution ladder, downward from source only, never
# upscaling. Fixed bitrate table — standard, industry-typical values,
# not calculated per-title from source bitrate. ---
declare -A BITRATE=( [1080]="5000k" [720]="2800k" [480]="1200k" )
RUNGS=()

if [ "$SRC_HEIGHT" -ge 1080 ]; then
  RUNGS=(1080 720 480)
elif [ "$SRC_HEIGHT" -ge 720 ]; then
  RUNGS=(720 480)
elif [ "$SRC_HEIGHT" -ge 480 ]; then
  RUNGS=(480)
else
  # The light backend decides ABR eligibility (sourceHeight >= 480)
  # BEFORE ever dispatching this workflow — see backend/controllers/
  # serviceController.js's decideAndDispatchAbr. Reaching this branch
  # means that check was bypassed or is out of sync with this script's
  # own floor, which is a real bug worth failing loudly on, not silently
  # no-op'ing.
  echo "ERROR: source height (${SRC_HEIGHT}p) is below the 480p floor — this workflow should never have been dispatched for this source." >&2
  exit 1
fi

echo "Source height: ${SRC_HEIGHT}p — ladder: ${RUNGS[*]}"

# --- Probe audio streams: index + language tag (if any) ---
AUDIO_JSON=$(ffprobe -v error -select_streams a -show_entries stream=index:stream_tags=language -of json "$INPUT")
AUDIO_COUNT=$(echo "$AUDIO_JSON" | jq '.streams | length')

if [ "$AUDIO_COUNT" -eq 0 ]; then
  echo "No audio streams detected — generating a video-only HLS ladder (silent source)."
else
  echo "Detected ${AUDIO_COUNT} audio stream(s)."
fi

# Build per-stream language/label/default arrays. Language defaults to
# "und" (undetermined) when the source has no language tag at all —
# common for amateur/own-upload rips. Never guess a language that
# wasn't actually tagged. The default (auto-selected) track is whichever
# stream is tagged "eng", if any; otherwise the first stream by index.
# These arrays simply stay empty when AUDIO_COUNT is 0 — the loop below
# never runs.
LANGUAGES=()
LABELS=()
DEFAULT_AUDIO_POSITION=0
FOUND_ENG=0

for ((i = 0; i < AUDIO_COUNT; i++)); do
  LANG=$(echo "$AUDIO_JSON" | jq -r ".streams[$i].tags.language // \"und\"")
  LANGUAGES+=("$LANG")
  if [ "$LANG" = "und" ]; then
    LABELS+=("Audio $((i + 1))")
  else
    LABELS+=("$(echo "$LANG" | tr '[:lower:]' '[:upper:]')")
  fi
  if [ "$LANG" = "eng" ] && [ "$FOUND_ENG" -eq 0 ]; then
    DEFAULT_AUDIO_POSITION=$i
    FOUND_ENG=1
  fi
done
# If no English track was found, DEFAULT_AUDIO_POSITION stays 0 (the
# first stream), set above.

# --- Slice 16: probe subtitle streams — index + codec + language tag ---
# Filtered to text-based codecs only (see header comment). SUB_INDEXES
# holds the ORIGINAL ffprobe subtitle-relative stream index (what
# `-map 0:s:N` needs); everything else is keyed by POSITION among
# qualifying (extracted) tracks, 0-based and contiguous, which is what
# both the output filenames (subs_0.vtt, subs_1.vtt, ...) and the
# reported subtitleTracks array use — a skipped bitmap track never
# leaves a gap in that numbering.
SUBTITLE_JSON=$(ffprobe -v error -select_streams s -show_entries stream=index:codec_name:stream_tags=language -of json "$INPUT")
SUBTITLE_STREAM_COUNT=$(echo "$SUBTITLE_JSON" | jq '.streams | length')

TEXT_SUBTITLE_CODECS="subrip ass ssa mov_text webvtt"

SUB_INDEXES=()
SUB_LANGUAGES=()
SUB_LABELS=()

if [ "$SUBTITLE_STREAM_COUNT" -gt 0 ]; then
  echo "Detected ${SUBTITLE_STREAM_COUNT} embedded subtitle stream(s) — filtering to text-based codecs."

  for ((i = 0; i < SUBTITLE_STREAM_COUNT; i++)); do
    CODEC=$(echo "$SUBTITLE_JSON" | jq -r ".streams[$i].codec_name")
    LANG=$(echo "$SUBTITLE_JSON" | jq -r ".streams[$i].tags.language // \"und\"")

    IS_TEXT=0
    for TC in $TEXT_SUBTITLE_CODECS; do
      if [ "$CODEC" = "$TC" ]; then
        IS_TEXT=1
        break
      fi
    done

    if [ "$IS_TEXT" -eq 0 ]; then
      echo "Skipping subtitle stream $i (codec: $CODEC) — bitmap-based or unsupported, cannot convert to WebVTT."
      continue
    fi

    SUB_INDEXES+=("$i")
    SUB_LANGUAGES+=("$LANG")
    POSITION=$((${#SUB_INDEXES[@]} - 1))
    if [ "$LANG" = "und" ]; then
      SUB_LABELS+=("Subtitle $((POSITION + 1))")
    else
      SUB_LABELS+=("$(echo "$LANG" | tr '[:lower:]' '[:upper:]')")
    fi
  done
else
  echo "No embedded subtitle streams found."
fi

SUBTITLE_COUNT=${#SUB_INDEXES[@]}
if [ "$SUBTITLE_COUNT" -gt 0 ]; then
  echo "Extracting ${SUBTITLE_COUNT} text-based subtitle track(s)."
elif [ "$SUBTITLE_STREAM_COUNT" -gt 0 ]; then
  echo "No usable (text-based) embedded subtitle streams to extract — all were bitmap-based or unsupported."
fi

for ((pos = 0; pos < SUBTITLE_COUNT; pos++)); do
  SIDX="${SUB_INDEXES[$pos]}"
  ffmpeg -y -i "$INPUT" -map "0:s:${SIDX}" "${OUTPUT_DIR}/subs_${pos}.vtt"
done

# --- Build the dynamic ffmpeg filter_complex + stream map (video + audio only — subtitles are extracted separately above, not part of this command) ---
NUM_RUNGS=${#RUNGS[@]}
SPLIT_LABELS=""
for ((i = 0; i < NUM_RUNGS; i++)); do
  SPLIT_LABELS="${SPLIT_LABELS}[v$((i + 1))]"
done

FILTER="[0:v]split=${NUM_RUNGS}${SPLIT_LABELS}"
for ((i = 0; i < NUM_RUNGS; i++)); do
  H="${RUNGS[$i]}"
  FILTER="${FILTER}; [v$((i + 1))]scale=-2:${H}[v$((i + 1))out]"
done

FFMPEG_ARGS=(-i "$INPUT" -filter_complex "$FILTER")

# Video rungs — only attach an agroup (linking each video rendition to
# the shared audio group) when there IS an audio group to link to. A
# silent source's variants stand alone with no agroup at all, which is
# valid HLS (a video-only variant stream).
VIDEO_STREAM_MAP=()
for ((i = 0; i < NUM_RUNGS; i++)); do
  H="${RUNGS[$i]}"
  BR="${BITRATE[$H]}"
  FFMPEG_ARGS+=(-map "[v$((i + 1))out]" -c:v:"$i" libx264 -preset veryfast -b:v:"$i" "$BR" -g 48 -keyint_min 48 -sc_threshold 0)
  if [ "$AUDIO_COUNT" -gt 0 ]; then
    VIDEO_STREAM_MAP+=("v:${i},agroup:audio-main")
  else
    VIDEO_STREAM_MAP+=("v:${i}")
  fi
done

# Audio rungs — this loop simply does nothing when AUDIO_COUNT is 0, so
# no -map 0:a:* args and no agroup entries are ever added for a silent
# source, without needing a separate branch here.
AUDIO_STREAM_MAP=()
for ((i = 0; i < AUDIO_COUNT; i++)); do
  FFMPEG_ARGS+=(-map "0:a:$i" -c:a:"$i" aac -b:a:"$i" 128k)
  LANG="${LANGUAGES[$i]}"
  DEFAULT_FLAG="NO"
  if [ "$i" -eq "$DEFAULT_AUDIO_POSITION" ]; then
    DEFAULT_FLAG="YES"
  fi
  AUDIO_STREAM_MAP+=("a:${i},agroup:audio-main,language:${LANG},default:${DEFAULT_FLAG}")
done

if [ "$AUDIO_COUNT" -gt 0 ]; then
  STREAM_MAP=$(IFS=' '; echo "${VIDEO_STREAM_MAP[*]} ${AUDIO_STREAM_MAP[*]}")
else
  STREAM_MAP=$(IFS=' '; echo "${VIDEO_STREAM_MAP[*]}")
fi

FFMPEG_ARGS+=(
  -f hls -hls_time 6 -hls_playlist_type vod
  -master_pl_name master.m3u8
  -var_stream_map "$STREAM_MAP"
  -hls_segment_filename "${OUTPUT_DIR}/stream_%v/seg_%03d.ts"
  "${OUTPUT_DIR}/stream_%v.m3u8"
)

echo "Running: ffmpeg ${FFMPEG_ARGS[*]}"
ffmpeg -y "${FFMPEG_ARGS[@]}"

# --- Slice 16: patch master.m3u8 with subtitle EXT-X-MEDIA declarations ---
# Only runs when at least one subtitle track was actually extracted — a
# source with none produces byte-for-byte the same manifest as before
# this slice, not a conditional variant of the file. No DEFAULT=YES is
# ever set on any subtitle track (unlike audio) — subtitles are opt-in;
# the player starts with them off and lets the viewer choose.
if [ "$SUBTITLE_COUNT" -gt 0 ]; then
  echo "Patching master.m3u8 with ${SUBTITLE_COUNT} subtitle track(s)."

  MEDIA_LINES=""
  for ((pos = 0; pos < SUBTITLE_COUNT; pos++)); do
    LABEL="${SUB_LABELS[$pos]}"
    LANG="${SUB_LANGUAGES[$pos]}"
    MEDIA_LINES="${MEDIA_LINES}#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"${LABEL}\",AUTOSELECT=YES,LANGUAGE=\"${LANG}\",URI=\"subs_${pos}.vtt\"
"
  done

  MASTER="${OUTPUT_DIR}/master.m3u8"

  # Inserts the EXT-X-MEDIA subtitle declarations right before the first
  # real content line (typically the first #EXT-X-STREAM-INF), i.e.
  # after #EXTM3U and, if present, #EXT-X-VERSION — rather than
  # hardcoding "after line 1", which would insert BEFORE a VERSION tag
  # if ffmpeg happens to write one on line 2. Also appends
  # SUBTITLES="subs" onto every existing #EXT-X-STREAM-INF line so each
  # resolution rendition correctly references the subtitle group.
  # Done with awk + a temp file rather than sed -i for portability
  # (GNU vs BSD sed's -i flag differs; this workflow always runs on
  # ubuntu-latest anyway, but awk keeps the script trivially portable
  # regardless).
  awk -v media="$MEDIA_LINES" '
    BEGIN { inserted = 0 }
    {
      if (!inserted && $0 !~ /^#EXTM3U/ && $0 !~ /^#EXT-X-VERSION/) {
        printf "%s", media
        inserted = 1
      }
      if ($0 ~ /^#EXT-X-STREAM-INF:/) {
        sub(/$/, ",SUBTITLES=\"subs\"")
        print
        next
      }
      print
    }
  ' "$MASTER" > "${MASTER}.patched"

  mv "${MASTER}.patched" "$MASTER"

  echo "Patched master.m3u8:"
  cat "$MASTER"
fi

# --- Write manifest-info.json describing what was produced ---
# Segment counts and final storage keys aren't known here — the calling
# workflow fills those in once it knows the upload prefix, after this
# script's output is uploaded to storage. streamIndex is included so the
# workflow can find each rendition's segment folder (output/stream_N/).
RENDITIONS_JSON="[]"
for ((i = 0; i < NUM_RUNGS; i++)); do
  H="${RUNGS[$i]}"
  BR="${BITRATE[$H]}"
  BR_NUM=$(echo "$BR" | tr -d 'k')
  RENDITIONS_JSON=$(echo "$RENDITIONS_JSON" | jq --arg res "${H}p" --argjson h "$H" --argjson br "$BR_NUM" --argjson idx "$i" \
    '. + [{resolution: $res, height: $h, bitrateKbps: $br, streamIndex: $idx}]')
done

# Naturally produces "[]" when AUDIO_COUNT is 0 — a silent film's
# audioTracks field on the Film document ends up empty/absent, which
# the frontend already treats correctly (no track selector rendered).
AUDIO_TRACKS_JSON="[]"
for ((i = 0; i < AUDIO_COUNT; i++)); do
  IS_DEFAULT="false"
  if [ "$i" -eq "$DEFAULT_AUDIO_POSITION" ]; then IS_DEFAULT="true"; fi
  AUDIO_TRACKS_JSON=$(echo "$AUDIO_TRACKS_JSON" | jq --argjson idx "$i" --arg lang "${LANGUAGES[$i]}" --arg label "${LABELS[$i]}" --argjson isDefault "$IS_DEFAULT" \
    '. + [{index: $idx, language: $lang, label: $label, isDefault: $isDefault}]')
done

# Slice 16 — subtitleTracks. "index" here is the 0-based POSITION among
# extracted tracks (matching the subs_N.vtt filenames), not the
# original ffprobe subtitle-stream index — a skipped bitmap track never
# leaves a gap. No "isDefault" field — subtitles have no default track
# (see the patching step above).
SUBTITLE_TRACKS_JSON="[]"
for ((pos = 0; pos < SUBTITLE_COUNT; pos++)); do
  SUBTITLE_TRACKS_JSON=$(echo "$SUBTITLE_TRACKS_JSON" | jq --argjson idx "$pos" --arg lang "${SUB_LANGUAGES[$pos]}" --arg label "${SUB_LABELS[$pos]}" \
    '. + [{index: $idx, language: $lang, label: $label}]')
done

jq -n \
  --argjson sourceHeight "$SRC_HEIGHT" \
  --argjson renditions "$RENDITIONS_JSON" \
  --argjson audioTracks "$AUDIO_TRACKS_JSON" \
  --argjson subtitleTracks "$SUBTITLE_TRACKS_JSON" \
  '{sourceHeight: $sourceHeight, renditions: $renditions, audioTracks: $audioTracks, subtitleTracks: $subtitleTracks}' \
  > "${OUTPUT_DIR}/manifest-info.json"

echo "Wrote ${OUTPUT_DIR}/manifest-info.json:"
cat "${OUTPUT_DIR}/manifest-info.json"
