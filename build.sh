#!/bin/bash
# Build the Zotero Auto-Tag plugin .xpi
cd "$(dirname "$0")" && rm -f ../auto-tag@shae.dev.xpi && zip -r ../auto-tag@shae.dev.xpi manifest.json bootstrap.js chrome/ && echo "Built: auto-tag@shae.dev.xpi"
