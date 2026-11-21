#!/bin/sh
# Install as /opt/qiyi/bin/gateway; no request data is interpolated into this command.
set -eu
cd /opt/qiyi
exec /usr/bin/node dist/server/gateway.js
