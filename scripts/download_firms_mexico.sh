#!/usr/bin/env bash
# Descarga CSV anuales públicos de FIRMS para México (sin MAP_KEY). Solo lectura de fuentes públicas.
set -u
R="$HOME/nasa-space-apps-2026/data/raw"
b=https://firms.modaps.eosdis.nasa.gov/data/country
get(){ # producto año_ini año_fin
  p=$1; for y in $(seq $2 $3); do f="$R/$p/${p}_${y}_Mexico.csv"
    [ -s "$f" ] && { echo "ya existe $f"; continue; }
    curl -fL --retry 2 -m 600 -o "$f.part" "$b/$p/$y/${p}_${y}_Mexico.csv" && mv "$f.part" "$f" && echo "ok $p $y $(wc -c <"$f") bytes" || echo "FALLO $p $y"
  done; }
get modis 2000 2025
get viirs-snpp 2012 2025
echo FIN
