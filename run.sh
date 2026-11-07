#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
mkdir -p data
exec flock -n data/run.lock .venv/bin/python server.py "$@"
