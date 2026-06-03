#!/usr/bin/env bash
# Sync project-level settings into user-level config directories.
# Supports both Claude Code (.claude/settings.local.json -> ~/.claude/settings.json)
# and Open Code (opencode.json -> ~/.config/opencode/opencode.json).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

merge_json() {
  local src="$1" dst="$2"
  python3 - "$src" "$dst" <<'PYEOF'
import json, sys

proj_path, user_path = sys.argv[1], sys.argv[2]

with open(proj_path) as f:
    proj = json.load(f)
with open(user_path) as f:
    user = json.load(f)

changed = False

def merge_array(user_obj, proj_obj, key_path):
    """Merge proj permissions into user permissions, dedup arrays."""
    global changed
    for section in ("allow", "deny"):
        proj_items = proj_obj.get(section, [])
        user_items = user_obj.get(section, [])
        existing = set(user_items)
        new_items = [i for i in proj_items if i not in existing]
        if new_items:
            user_obj[section] = user_items + new_items
            changed = True
            print(f"  + {key_path}.{section}: added {len(new_items)} item(s)")
            for item in new_items:
                print(f"      {item}")

# Merge permissions
if "permissions" in proj:
    if "permissions" not in user:
        user["permissions"] = {}
    merge_array(user["permissions"], proj["permissions"], "permissions")

# Merge hooks (project hooks appended, not deduped since commands may differ)
if "hooks" in proj:
    if "hooks" not in user:
        user["hooks"] = {}
    for event, proj_hook_list in proj["hooks"].items():
        if event not in user["hooks"]:
            user["hooks"][event] = proj_hook_list
            changed = True
            print(f"  + hooks.{event}: added {len(proj_hook_list)} hook group(s)")
        else:
            # Dedupe by command string
            existing_cmds = set()
            for group in user["hooks"][event]:
                for h in group.get("hooks", []):
                    existing_cmds.add(h.get("command", ""))
            new_groups = []
            for group in proj_hook_list:
                is_new = False
                for h in group.get("hooks", []):
                    if h.get("command", "") not in existing_cmds:
                        is_new = True
                        break
                if is_new:
                    new_groups.append(group)
            if new_groups:
                user["hooks"][event].extend(new_groups)
                changed = True
                print(f"  + hooks.{event}: added {len(new_groups)} hook group(s)")

# Merge other top-level keys (only add if not present in user config)
for key, value in proj.items():
    if key in ("permissions", "hooks"):
        continue
    if key not in user:
        user[key] = value
        changed = True
        print(f"  + {key}: added")

if changed:
    with open(user_path, "w") as f:
        json.dump(user, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"\nSaved to {user_path}")
else:
    print("Nothing to merge, user config is up to date.")
PYEOF
}

sync_one() {
  local src="$1" dst="$2" label="$3"

  if [ ! -f "$src" ]; then
    echo "Skip $label: $src not found"
    return
  fi

  echo "=== $label ==="
  mkdir -p "$(dirname "$dst")"

  if [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    echo "Created $dst"
    return
  fi

  merge_json "$src" "$dst"
}

sync_one "$SCRIPT_DIR/../.claude/settings.local.json" "$HOME/.claude/settings.json" "Claude Code"
sync_one "$SCRIPT_DIR/../opencode.json" "$HOME/.config/opencode/opencode.json" "Open Code"
