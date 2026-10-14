#!/bin/sh
# Stands in for the program the closed process starts and reports the limit for
# memory images that the process was given.
printf '{"core":"%s"}' "$(ulimit -c)"
