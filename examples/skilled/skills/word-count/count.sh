#!/bin/sh
# Prints the number of words in its first argument.
printf '%s\n' "$1" | wc -w
