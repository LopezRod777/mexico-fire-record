# Registro de incendios de México, 2000–2025

Proyecto para NASA Space Apps Challenge 2026, reto "Harmonization of MODIS and VIIRS Hot Spots".

Una serie de detecciones de incendio de México en escala VIIRS (MODIS de 2000 a 2011 llevado a la escala de S-NPP), con diagnósticos de la salud del registro, un error medido por región y una capa casi en tiempo real. La web está en español e inglés (selector ES | EN, o `?lang=en`).

## Qué incluye la web (`web/`)
- Mapa y calendario de actividad por estado, con serie armonizada y descarga CSV.
- Salud del registro: hora de paso de cada satélite, razón de conteos, versiones del producto MODIS, probabilidad de que MODIS vea lo que ve VIIRS.
- Confianza de la armonización: error mensual medido con validación dejando un año fuera.
- Hoy: detecciones de NOAA-20 y NOAA-21 de las últimas 24 h comparadas contra el historial de S-NPP; el conteo real de MODIS NRT (Terra y Aqua) en la misma ventana de 24 h; y una capa con lo más reciente de GOES-18 y GOES-19 (3 h previas a la captura, juntadas en celdas de 0.02°, para ver lo último y no para contar).
- Hoy, capa opcional de humo: áreas de humo que analistas del Hazard Mapping System (HMS) de NOAA trazan sobre imágenes diurnas de GOES, solo las que tocan México en la ventana de 24 h de la captura. Se puede ocultar, no se suma a ningún conteo y, en "Vi un fuego", añade una frase si el punto cae dentro de un trazo.

Es estática (HTML, CSS y JS sin dependencias). Para verla: `python3 -m http.server -d web 8765`.

## Método y límites
- Unidad: celdas-día de 0.05° con al menos una detección.
- Julio 2002 a diciembre 2011: celdas con detección de Terra o Aqua (unión) × factor mensual calculado con 2012–2021. Noviembre 2000 a junio 2002: solo Terra × factor mensual.
- La banda de error es heurística (valor × error mediano), no un intervalo estadístico.
- Validación dejando un año fuera (2012–2021): error mensual mediano entre estados 19.5 % con la unión (24.8 % con solo Aqua); nacional 5.5 %. Solo Terra: mediana estatal 27.0 %. Piso estimado por conteos pequeños: ~6.7 % (experiments/e17_error.py).
- La validación solo cubre 2012–2021. Aplicarla a 2002–2011 es extrapolación no probada.
- NOAA-20/21 se compararon con S-NPP en 20 días de marzo de 2025 (razones 1.02 y 1.00). No está verificado fuera de ese periodo.
- Los datos NRT no son de calidad científica y la capa "Hoy" es una captura, no se actualiza sola.
- GOES: FIRMS entrega cada imagen con dos algoritmos (G19/G18 = NOAA FDC, G19FRP/G18FRP = KCL/IPMA FRP-PIXEL; ver la FAQ de FIRMS) y GOES-18 y GOES-19 ven México a la vez, así que el mismo calor se repite; por eso no se cuenta. Si MODIS o GOES fallan al bajar, la captura de VIIRS sigue y el fallo queda en `fetch_info.json`.
- Humo (NOAA HMS): los polígonos son áreas donde un analista vio humo en imágenes diurnas de GOES; no son perímetros de incendio ni prueba de fuego en un punto. De noche no se traza y las nubes pueden taparlo, así que la falta de trazo no significa que no haya humo. Light, Medium y Heavy son categorías del analista, no concentraciones medidas. El archivo del día empieza vacío y se llena durante el día; la captura baja el de hoy y el de ayer (UTC), se queda con los que tocan la geometría de los estados (no el recuadro, que incluye el sur de EE. UU., el Golfo y Centroamérica) y simplifica las formas a ~0.5 km. Si la descarga falla, la captura de VIIRS sigue y el fallo queda en `fetch_info.json`. El lector de shapefile es propio (`pipeline/shapefile_min.py`), sin dependencias nuevas.
- S-NPP dejó de entregar datos en FIRMS el 2 de noviembre de 2026; 2026 no está en la serie.
- Sin detección no significa sin fuego.

## Reproducir los datos
1. `scripts/download_firms_mexico.sh` baja los CSV anuales públicos de NASA FIRMS (sin llave).
2. `pip install -r requirements.txt`, luego `pipeline/` (agregados, diagnósticos, asignación a estados, exportación a `web/data/`).
3. La capa en vivo usa la API de FIRMS con `FIRMS_MAP_KEY` como variable de entorno (no incluida).
4. Pruebas: `node --test web/tests/` y, una por una, `for f in tests/test_*.py; do python "$f" || break; done`.

`data/raw` y `data/processed` no se incluyen por tamaño (~900 MB); se regeneran con los pasos anteriores. Los JSON que usa la web ya están en `web/data/`.

## Use of AI / Uso de IA
EN: AI coding assistants (Anthropic Claude and OpenAI Codex) were used, under the team's direction, to write and review code, data pipelines, tests and website text. Every figure on the site is computed by the code in this repository from public NASA FIRMS data and is checked by automated tests. No image, video or audio on the site is AI-generated: the photographs are from NASA Earth Observatory and NOAA/CIRA.

ES: Se usaron asistentes de programación con IA (Claude de Anthropic y Codex de OpenAI), bajo la dirección del equipo, para escribir y revisar código, pipelines de datos, pruebas y textos de la web. Cada cifra de la web la calcula el código de este repositorio a partir de datos públicos de NASA FIRMS y la comprueban pruebas automáticas. Ninguna imagen, video o audio de la web está generado con IA: las fotografías son de NASA Earth Observatory y NOAA/CIRA.

## Créditos
Datos: NASA FIRMS (https://firms.modaps.eosdis.nasa.gov/): VIIRS NOAA-20 y NOAA-21 NRT, MODIS (Terra y Aqua, incluido MODIS NRT) y GOES-18/19 de NOAA (FDC de NOAA y FRP-PIXEL de KCL/IPMA) vía FIRMS. Humo: NOAA/NESDIS, Hazard Mapping System (HMS) Fire and Smoke Product (https://www.ospo.noaa.gov/products/land/hms.html). Contorno de estados: Natural Earth (dominio público). Imágenes: NASA Earth Observatory, NOAA y CSU/CIRA, dominio público, vía Wikimedia Commons (detalle en el pie de la web). Tipografías: Fraunces e IBM Plex Sans (OFL-1.1).
