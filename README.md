# Registro de incendios de México, 2000–2025

Proyecto para NASA Space Apps Challenge 2026, reto "Harmonization of MODIS and VIIRS Hot Spots".

Una serie de detecciones de incendio de México en escala VIIRS (MODIS de 2000 a 2011 llevado a la escala de S-NPP), con diagnósticos de la salud del registro, un error medido por región y una capa casi en tiempo real.

## Qué incluye la web (`web/`)
- Mapa y calendario de actividad por estado, con serie armonizada y descarga CSV.
- Salud del registro: hora de paso de cada satélite, razón de conteos, versiones del producto MODIS, probabilidad de que MODIS vea lo que ve VIIRS.
- Confianza de la armonización: error mensual medido con validación dejando un año fuera.
- Hoy: detecciones de NOAA-20 y NOAA-21 de las últimas 24 h comparadas contra el historial de S-NPP.

Es estática (HTML, CSS y JS sin dependencias). Para verla: `python3 -m http.server -d web 8765`.

## Método y límites
- Unidad: celdas-día de 0.05° con al menos una detección.
- Factor mensual por sensor calculado con 2012–2021 (años en que se solapan antes de la deriva orbital).
- La banda de error es heurística (valor × error mediano), no un intervalo estadístico.
- Error nacional 5.3 %; mediana entre estados 24.8 % (rango 13–44 %).
- La validación solo cubre 2012–2021. Aplicarla a 2002–2011 es extrapolación no probada.
- NOAA-20/21 se compararon con S-NPP en 20 días de marzo de 2025 (razones 1.02 y 1.00). No está verificado fuera de ese periodo.
- Los datos NRT no son de calidad científica y la capa "Hoy" es una captura, no se actualiza sola.
- S-NPP dejó de entregar datos en FIRMS el 2 de noviembre de 2026; 2026 no está en la serie.
- Sin detección no significa sin fuego.

## Reproducir los datos
1. `scripts/download_firms_mexico.sh` baja los CSV anuales públicos de NASA FIRMS (sin llave).
2. `pip install -r requirements.txt`, luego `pipeline/` (agregados, diagnósticos, asignación a estados, exportación a `web/data/`).
3. La capa en vivo usa la API de FIRMS con `FIRMS_MAP_KEY` como variable de entorno (no incluida).
4. Pruebas: `node --test web/tests/` y `python tests/test_*.py`.

`data/raw` y `data/processed` no se incluyen por tamaño (~900 MB); se regeneran con los pasos anteriores. Los JSON que usa la web ya están en `web/data/`.

## Créditos
Datos: NASA FIRMS (https://firms.modaps.eosdis.nasa.gov/). Contorno de estados: Natural Earth (dominio público).
