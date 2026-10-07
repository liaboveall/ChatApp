#!/bin/sh
# Fixed child/grandchild tree; the primary Bun probe owns the task process group.
[ "$#" -eq 0 ] || exit 1
/usr/bin/sleep 90 &
printf '{"child":%s,"grandchild":%s}\n' "$$" "$!"
wait
