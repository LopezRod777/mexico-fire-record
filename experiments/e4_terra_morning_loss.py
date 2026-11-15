# E4: ¿qué se pierde si Terra (órbita de mañana ~10:30 local / noche 22:30) se apaga?
# Para cada celda-día 0.02° con detección Terra, ¿hubo detección de Aqua o S-NPP (tarde 13:30) la misma fecha UTC / el día siguiente?
import duckdb
con=duckdb.connect()
T="types={'acq_time':'VARCHAR','confidence':'VARCHAR'}"
con.execute(f"CREATE VIEW m AS SELECT * FROM read_csv('data/raw/modis/*.csv', union_by_name=true, {T}) WHERE acq_date>='2012-01-20'")
con.execute(f"CREATE VIEW v AS SELECT *, 'VIIRS' sensor FROM read_csv('data/raw/viirs-snpp/*.csv', union_by_name=true, {T}) WHERE acq_date>='2012-01-20'")
q="""
WITH t AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn, sum(frp) ft FROM m WHERE satellite='Terra' GROUP BY ALL),
p AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d FROM (SELECT latitude,longitude,acq_date FROM m WHERE satellite='Aqua' UNION ALL SELECT latitude,longitude,acq_date FROM v) GROUP BY ALL),
r AS (SELECT t.*, (p0.i IS NOT NULL) tarde_mismo_dia, (p0.i IS NOT NULL OR p1.i IS NOT NULL) tarde_mismo_o_sig, (pm.i IS NOT NULL) tarde_dia_previo
 FROM t LEFT JOIN p p0 ON p0.i=t.i AND p0.j=t.j AND p0.d=t.d
        LEFT JOIN p p1 ON p1.i=t.i AND p1.j=t.j AND p1.d=t.d+INTERVAL 1 DAY
        LEFT JOIN p pm ON pm.i=t.i AND pm.j=t.j AND pm.d=t.d-INTERVAL 1 DAY)
SELECT dn, CASE WHEN ft<3 THEN '1 <3MW' WHEN ft<10 THEN '2 3-10' WHEN ft<30 THEN '3 10-30' ELSE '4 30+' END bin, count(*) celdas_terra,
 round(1-avg(tarde_mismo_dia::int),3) sin_visto_tarde_mismo_dia,
 round(1-avg(tarde_mismo_o_sig::int),3) sin_visto_mismo_o_siguiente,
 round(avg(tarde_dia_previo::int),3) control_dia_previo_visto
FROM r GROUP BY ALL ORDER BY dn,bin"""
print(con.execute(q).df().to_string(index=False))
print(con.execute("select count(*) from m where satellite='Terra' and acq_date>='2012-01-20'").fetchone()[0],'detecciones Terra 2012+')
