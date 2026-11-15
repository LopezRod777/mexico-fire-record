#!/usr/bin/env bash
# Réplica: CSV anuales públicos de FIRMS para Estados Unidos (2018-2025). Sin llave. Solo lectura de fuentes públicas.
set -u
R="$HOME/nasa-space-apps-2026/data/raw_us"; b=https://firms.modaps.eosdis.nasa.gov/data/country
for y in $(seq 2018 2025); do
 for p in modis viirs-snpp; do f="$R/$p/${p}_${y}_United_States.csv"
  [ -s "$f" ] && { echo "ya existe $p $y"; continue; }
  curl -fL --retry 2 -m 900 -o "$f.part" "$b/$p/$y/${p}_${y}_United_States.csv" && mv "$f.part" "$f" && echo "ok $p $y $(wc -c <"$f") bytes" || echo "FALLO $p $y"
 done; done; echo FIN
