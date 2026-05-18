#!/usr/bin/env bash
# Sync project-level skills (.agents/skills/) to user-level skill directories
# so they are available across all projects.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_SKILLS="$SCRIPT_DIR/skills"

# User-level skill directories (in priority order)
USER_DIRS=(
  "$HOME/.trae/skills"
  "$HOME/.coco/skills"
  "$HOME/.trae-cn/skills"
)

if [ ! -d "$PROJECT_SKILLS" ]; then
  echo "Error: $PROJECT_SKILLS not found"
  exit 1
fi

synced=0
for dir in "${USER_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    for skill_dir in "$PROJECT_SKILLS"/*/; do
      skill_name="$(basename "$skill_dir")"
      target="$dir/$skill_name"
      if [ -e "$target" ] && [ ! -L "$target" ]; then
        echo "Skip $skill_name -> $target (exists and is not a symlink)"
        continue
      fi
      ln -sfn "$skill_dir" "$target"
      echo "Linked $skill_name -> $target"
      synced=$((synced + 1))
    done
  else
    echo "Skip $dir (not found)"
  fi
done

echo "Done. Synced $synced skill(s)."
