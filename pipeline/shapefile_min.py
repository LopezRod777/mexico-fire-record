"""Lector mínimo de shapefile de polígonos (tipos 5, 15 y 25) y de su tabla dBASE, sin dependencias.

Sirve para los polígonos de humo de NOAA HMS (hms_smokeAAAAMMDD.zip). Lee de bytes, valida
longitudes y termina con ShapefileError si el archivo está truncado o no es lo esperado.
Referencia del formato: ESRI Shapefile Technical Description (julio de 1998).
"""
import io
import struct
import zipfile

POLYGON_TYPES = (5, 15, 25)  # Polygon, PolygonZ, PolygonM: la parte X/Y es idéntica


class ShapefileError(ValueError):
    pass


def read_polygons(data: bytes) -> list[list[list[tuple[float, float]]]]:
    """Registros del .shp, en orden: cada uno es una lista de anillos y cada anillo, de (x, y).

    Un registro nulo (tipo 0) da una lista vacía para no desalinear la tabla de atributos.
    """
    if len(data) < 100:
        raise ShapefileError("shp: encabezado incompleto")
    code, = struct.unpack(">i", data[:4])
    length_words, = struct.unpack(">i", data[24:28])
    version, shape_type = struct.unpack("<ii", data[28:36])
    if code != 9994 or version != 1000:
        raise ShapefileError("shp: no es un shapefile")
    if shape_type not in POLYGON_TYPES:
        raise ShapefileError(f"shp: tipo {shape_type} no es de polígonos")
    if length_words * 2 != len(data):
        raise ShapefileError("shp: la longitud declarada no coincide con el archivo")
    records, offset = [], 100
    while offset < len(data):
        if offset + 12 > len(data):
            raise ShapefileError("shp: registro truncado")
        _, content_words = struct.unpack(">ii", data[offset:offset + 8])
        start, end = offset + 8, offset + 8 + content_words * 2
        if content_words < 2 or end > len(data):
            raise ShapefileError("shp: registro truncado")
        record_type, = struct.unpack("<i", data[start:start + 4])
        if record_type == 0:
            records.append([])
        elif record_type != shape_type:
            raise ShapefileError(f"shp: registro de tipo {record_type} en un archivo de tipo {shape_type}")
        else:
            if start + 44 > end:
                raise ShapefileError("shp: polígono truncado")
            n_parts, n_points = struct.unpack("<ii", data[start + 36:start + 44])
            parts_at = start + 44
            points_at = parts_at + 4 * n_parts
            if n_parts < 1 or n_points < 1 or points_at + 16 * n_points > end:
                raise ShapefileError("shp: polígono truncado")
            parts = list(struct.unpack(f"<{n_parts}i", data[parts_at:points_at]))
            if parts[0] != 0 or any(b <= a for a, b in zip(parts, parts[1:])) or parts[-1] >= n_points:
                raise ShapefileError("shp: índices de anillos inválidos")
            flat = struct.unpack(f"<{2 * n_points}d", data[points_at:points_at + 16 * n_points])
            points = list(zip(flat[0::2], flat[1::2]))
            records.append([points[a:b] for a, b in zip(parts, parts[1:] + [n_points])])
        offset = end
    return records


def read_dbf(data: bytes) -> list[dict[str, str]]:
    """Filas de la tabla dBASE como texto sin espacios de relleno. Omite las marcadas como borradas."""
    if len(data) < 33:
        raise ShapefileError("dbf: encabezado incompleto")
    n_records, header_len, record_len = struct.unpack("<IHH", data[4:12])
    if header_len < 33 or header_len > len(data) or record_len < 1:
        raise ShapefileError("dbf: encabezado inválido")
    fields, offset = [], 32
    while offset < header_len - 1 and data[offset] != 0x0D:
        if offset + 32 > header_len:
            raise ShapefileError("dbf: descriptor de campo truncado")
        name = data[offset:offset + 11].split(b"\x00")[0].decode("ascii")
        fields.append((name, data[offset + 16]))
        offset += 32
    if not fields or 1 + sum(size for _, size in fields) != record_len:
        raise ShapefileError("dbf: los campos no suman la longitud del registro")
    if header_len + n_records * record_len > len(data):
        raise ShapefileError("dbf: registros truncados")
    rows = []
    for i in range(n_records):
        record = data[header_len + i * record_len:header_len + (i + 1) * record_len]
        if record[:1] == b"*":
            continue
        row, at = {}, 1
        for name, size in fields:
            row[name] = record[at:at + size].decode("latin-1").strip()
            at += size
        rows.append(row)
    return rows


def read_zip(data: bytes) -> list[dict]:
    """Zip con un .shp y un .dbf: lista de {"anillos": [...], "atributos": {...}} por registro."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            shp = [name for name in names if name.lower().endswith(".shp")]
            dbf = [name for name in names if name.lower().endswith(".dbf")]
            if len(shp) != 1 or len(dbf) != 1:
                raise ShapefileError("zip: se esperaba un .shp y un .dbf")
            shapes, rows = read_polygons(archive.read(shp[0])), read_dbf(archive.read(dbf[0]))
    except (zipfile.BadZipFile, KeyError, EOFError, struct.error, UnicodeDecodeError) as error:
        raise ShapefileError(f"zip: ilegible ({type(error).__name__})") from error
    if len(shapes) != len(rows):
        raise ShapefileError(f"zip: {len(shapes)} polígonos y {len(rows)} filas de atributos")
    return [{"anillos": rings, "atributos": attrs} for rings, attrs in zip(shapes, rows)]
