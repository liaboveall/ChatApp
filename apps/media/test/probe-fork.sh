#!/bin/sh
# Fixed hostile process only in the fault image. No arguments or ambient command/URL/path selection.
[ "$#" -eq 0 ] || exit 1
# dash exits on a failed fork. Release four owned sleepers in its EXIT trap, before
# Bun's child-exit callback runs: that callback may otherwise abort allocating a thread
# at the exact kernel limit. The pids.peak/events witness remains at 64 / denied-fork.
release_pids=''
trap 'kill $release_pids 2>/dev/null || :' EXIT
i=0
while [ "$i" -lt 80 ]; do
  /usr/bin/sleep 90 &
  if [ "$i" -lt 4 ]; then release_pids="$release_pids $!"; fi
  i=$((i + 1))
done
wait
