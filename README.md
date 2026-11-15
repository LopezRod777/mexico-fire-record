# Registro de incendios de México, 2000–2026

Proyecto para NASA Space Apps Challenge 2026, reto "Harmonization of MODIS and VIIRS Hot Spots".

Una serie de detecciones de incendio de México en escala VIIRS (MODIS de 2000 a 2011 llevado a la escala de S-NPP), con diagnósticos de la salud del registro, un error medido por región y una capa casi en tiempo real. La web está en español e inglés (selector ES | EN, o `?lang=en`).

## Qué incluye la web (`web/`)
- Mapa y calendario de actividad por estado, con serie armonizada y descarga CSV.
- Salud del registro: hora de paso de cada satélite, razón de conteos, versiones del producto MODIS, probabilidad de que MODIS vea lo que ve VIIRS.
- Confianza de la armonización: error mensual medido con validación dejando un año fuera.
- Hoy: detecciones de NOAA-20 y NOAA-21 de las últimas 24 h comparadas contra el historial de S-NPP; el conteo real de MODIS NRT (Terra y Aqua) en la misma ventana de 24 h; y una capa con lo más reciente de GOES-18 y GOES-19 (3 h previas a la captura, juntadas en celdas de 0.02°, para ver lo último y no para contar).
- Hoy, capa opcional de humo: áreas de humo que analistas del Hazard Mapping System (HMS) de NOAA trazan sobre imágenes diurnas de GOES, solo las plumas locales que tocan México en la ventana de 24 h de la captura (las áreas de más de 50,000 km², bruma regional, se dejan fuera). Se puede ocultar, no se suma a ningún conteo y, en "Vi un fuego", añade una frase si el punto cae dentro de un trazo.

Es estática (HTML, CSS y JS sin framework ni paso de compilación; la única biblioteca es satellite.js 7.1.0, incluida en `web/vendor`). Para verla: `python3 -m http.server -d web 8765`.

## Método y límites
- Unidad: celdas-día de 0.05° con al menos una detección.
- Julio 2002 a diciembre 2011: celdas con detección de Terra o Aqua (unión) × factor mensual calculado con 2012–2021. Noviembre 2000 a junio 2002: solo Terra × factor mensual.
- La banda de error es heurística (valor × error mediano), no un intervalo estadístico.
- Validación dejando un año fuera (2012–2021): error mensual mediano entre estados 19.5 % con la unión (24.8 % con solo Aqua); nacional 5.5 %. Solo Terra: mediana estatal 27.0 %. Piso estimado por conteos pequeños: ~6.7 % (experiments/e17_error.py).
- La validación solo cubre 2012–2021. Aplicarla a los años anteriores a 2012 es extrapolación no probada.
- NOAA-20/21 se compararon con S-NPP en 20 días de marzo de 2025 (razones 1.02 y 1.00). No está verificado fuera de ese periodo.
- Los datos NRT no son de calidad científica. La capa "Hoy" es una captura que se renueva sola (ver "Captura autónoma"); la página abierta no se recarga, así que muestra la captura que había al cargarla.
- GOES: FIRMS entrega cada imagen con dos algoritmos (G19/G18 = NOAA FDC, G19FRP/G18FRP = KCL/IPMA FRP-PIXEL; ver la FAQ de FIRMS) y GOES-18 y GOES-19 ven México a la vez, así que el mismo calor se repite; por eso no se cuenta. Si MODIS o GOES fallan al bajar, la captura de VIIRS sigue y el fallo queda en `fetch_info.json`.
- Humo (NOAA HMS): los polígonos son áreas donde un analista vio humo en imágenes diurnas de GOES; no son perímetros de incendio ni prueba de fuego en un punto. De noche no se traza y las nubes pueden taparlo, así que la falta de trazo no significa que no haya humo. Light, Medium y Heavy son categorías del analista, no concentraciones medidas. El archivo del día empieza vacío y se llena durante el día; la captura baja el de hoy y el de ayer (UTC), se queda con los que tocan la geometría de los estados (no el recuadro, que incluye el sur de EE. UU., el Golfo y Centroamérica), deja fuera los de más de 50,000 km² (el 14 nov 2026 las 8 plumas locales medían de 48 a 4,979 km² y las 3 áreas regionales, de 1.08 a 11.5 millones de km²; cuántas se omiten queda en `n_regionales_omitidas`) y simplifica las formas a ~0.5 km. Si la descarga falla, la captura de VIIRS sigue y el fallo queda en `fetch_info.json`. El lector de shapefile es propio (`pipeline/shapefile_min.py`), sin dependencias nuevas.
- S-NPP dejó de entregar datos en FIRMS el 2 de noviembre de 2026, así que la serie llega hasta octubre de 2026, el último mes completo (noviembre de 2000 a octubre de 2026 son 312 meses, 26 años). Los meses de 2026 que vienen del producto casi en tiempo real (S-NPP desde agosto, MODIS desde septiembre) son provisionales y pueden cambiar cuando NASA publique la versión estándar; van marcados en `provisional`, en el calendario y en el CSV. Los factores, la validación y la línea base de "Hoy" (2012–2025) no usan 2026.
- 2026 todavía no tiene CSV anual por país, así que sale de la API de área de FIRMS con el recuadro de la capa en vivo y se queda con las celdas cuyo centro cae en un estado. En abril y mayo de 2025, todas las filas del CSV por país estaban idénticas en la API y ese camino dio entre 0.05 % y 0.20 % más celdas-día que el CSV (detecciones del otro lado de la frontera en celdas mexicanas).
- Hay 53 días en 15 meses desde 2012 en que S-NPP no entregó datos sobre México (11 en julio de 2024; en 2026, 3 en marzo, 3 en abril, 2 en junio, 6 en julio y 1 en agosto). Esos días no se rellenan, así que el mes puede quedar por debajo de lo real: en 2026 NOAA-20 vio en esos días entre el 5 % y el 20 % de sus celdas-día del mes. Quedan en `dias_sin_deteccion` y en el detalle de cada mes del calendario. Los diagnósticos de "Salud del registro" usan años completos y llegan a 2025.
- Sin detección no significa sin fuego.

## Captura autónoma de "Hoy"
La capa "Hoy" se renueva sin intervención, en esta cadena:

1. Vercel Cron (`web/vercel.json`) llama a `/api/refresh` cada 15 minutos.
2. `web/api/refresh.js` comprueba el encabezado `Authorization` contra `CRON_SECRET` y pide a GitHub un `workflow_dispatch` del workflow `.github/workflows/live.yml`. No guarda ni devuelve datos, solo dispara.
3. `live.yml` baja FIRMS (`scripts/fetch_live.py`), regenera `web/data/live_snapshot.json` (`pipeline/live_snapshot.py`), la verifica contra los datos crudos (`tests/test_live.py`) y, solo si la captura cambió y la verificación pasa, hace commit a `main`, que es lo que la publica. El mismo workflow conserva su propio horario (minutos 7 y 37 de cada hora) como respaldo.

Configuración (solo nombres, los valores no viven en el repositorio):
- Variables de entorno del proyecto en Vercel: `CRON_SECRET` y `GH_DISPATCH_TOKEN` (token de GitHub con permiso para disparar el workflow).
- Secreto del repositorio en GitHub: `FIRMS_MAP_KEY` (llave de la API de NASA FIRMS).

Fuentes actuales de "Hoy": VIIRS de NOAA-20 y NOAA-21 (NRT), MODIS NRT (Terra y Aqua), GOES-18 y GOES-19, todas vía NASA FIRMS, y las plumas de humo del Hazard Mapping System (HMS) de NOAA. Las órbitas (TLE, de CelesTrak) de NOAA-20 y NOAA-21 para el próximo pase se bajan en la misma tarea.

## Reproducir los datos
1. `scripts/download_firms_mexico.sh` baja los CSV anuales públicos de NASA FIRMS (sin llave), que llegan a 2025. Para 2026, `FIRMS_MAP_KEY=… python scripts/download_firms_2026.py` baja la API de área en ventanas de 5 días (estándar donde exista, casi en tiempo real después) y `python pipeline/prepare_2026.py` revisa huecos y duplicados y deja solo México y meses completos.
2. `pip install -r requirements.txt`, luego `pipeline/` (agregados, diagnósticos, asignación a estados, exportación a `web/data/`).
3. La capa en vivo usa la API de FIRMS con `FIRMS_MAP_KEY` como variable de entorno (no incluida): `python scripts/fetch_live.py` y luego `python pipeline/live_snapshot.py`.
4. Pruebas: `node --test web/tests/` y, una por una, `for f in tests/test_*.py; do python "$f" || break; done`.

`data/raw` y `data/processed` no se incluyen por tamaño (~900 MB); se regeneran con los pasos anteriores. Los JSON que usa la web ya están en `web/data/`.

## Use of AI / Uso de IA
EN: AI coding assistants (Anthropic Claude and OpenAI Codex) were used, under the team's direction, to write and review code, data pipelines, tests and website text. Every figure on the site is computed by the code in this repository from public data (heat detections from NASA FIRMS, smoke plumes from NOAA HMS, orbits from CelesTrak and place names from GeoNames) and is checked by automated tests. No image, video or audio on the site is AI-generated: the photographs are from NASA Earth Observatory and NOAA/CIRA.

ES: Se usaron asistentes de programación con IA (Claude de Anthropic y Codex de OpenAI), bajo la dirección del equipo, para escribir y revisar código, pipelines de datos, pruebas y textos de la web. Cada cifra de la web la calcula el código de este repositorio a partir de datos públicos (detecciones de calor de NASA FIRMS, plumas de humo de NOAA HMS, órbitas de CelesTrak y localidades de GeoNames) y la comprueban pruebas automáticas. Ninguna imagen, video o audio de la web está generado con IA: las fotografías son de NASA Earth Observatory y NOAA/CIRA.

## Créditos
Datos: NASA FIRMS (https://firms.modaps.eosdis.nasa.gov/): VIIRS S-NPP (la escala de referencia), VIIRS NOAA-20 y NOAA-21 NRT, MODIS (Terra y Aqua, incluido MODIS NRT) y GOES-18/19 de NOAA (FDC de NOAA y FRP-PIXEL de KCL/IPMA) vía FIRMS. Humo: NOAA/NESDIS, Hazard Mapping System (HMS) Fire and Smoke Product (https://www.ospo.noaa.gov/products/land/hms.html). Contorno de estados: Natural Earth (dominio público). Localidades para describir un punto: GeoNames (https://www.geonames.org/), licencia CC BY 4.0, filtradas con `scripts/build_localidades.py`. Imágenes: NASA Earth Observatory, NOAA y CSU/CIRA, dominio público, vía Wikimedia Commons (detalle en el pie de la web). Órbitas: elementos GP de CelesTrak para NOAA-20 y NOAA-21, propagados con satellite.js 7.1.0 (licencia MIT, en `web/vendor`). Enlaces que abren otro sitio y no descargan nada: NASA Worldview y OpenStreetMap. Tipografías: Fraunces e IBM Plex Sans (OFL-1.1). Video de demostración (`web/video/`): grabación de la propia web, con música de Rafael Krux, «Horror Suspense» (CC0).
