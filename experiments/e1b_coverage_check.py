# E1b: control de cobertura. Proxy de "Aqua observó la zona": hubo >=1 detección Aqua en el bloque 1°x1° ese día/turno.
import duckdb
con=duckdb.connect()
T="types={'acq_time':'VARCHAR','confidence':'VARCHAR'}"
con.execute(f"CREATE VIEW m AS SELECT * FROM read_csv('data/raw/modis/*.csv', union_by_name=true, {T}) WHERE satellite='Aqua' AND acq_date>='2012-01-20'")
con.execute(f"CREATE VIEW v AS SELECT * FROM read_csv('data/raw/viirs-snpp/*.csv', union_by_name=true, {T}) WHERE acq_date>='2012-01-20'")
q="""
WITH a AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn, count(*) na FROM m GROUP BY ALL),
ab AS (SELECT cast(floor(latitude) as int) bi, cast(floor(longitude) as int) bj, acq_date d, daynight dn, count(*) nab FROM m GROUP BY ALL),
b AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, cast(floor(latitude) as int) bi, cast(floor(longitude) as int) bj, acq_date d, daynight dn, count(*) nv, sum(frp) fv FROM v GROUP BY ALL),
j AS (SELECT b.*, coalesce(a.na,0) na, coalesce(ab.nab,0) nab FROM b LEFT JOIN a USING(i,j,d,dn) LEFT JOIN ab USING(bi,bj,d,dn))
SELECT dn, CASE WHEN fv<3 THEN '1 <3MW' WHEN fv<10 THEN '2 3-10' WHEN fv<30 THEN '3 10-30' ELSE '4 30+' END bin,
 count(*) celdas_viirs,
 round(avg((na>0)::int),3) p_modis_ve_todas,
 round(avg((na>0)::int) FILTER (WHERE nab>0),3) p_modis_ve_si_aqua_paso,
 round(avg((nab>0)::int),3) frac_con_aqua_en_bloque
FROM j GROUP BY ALL ORDER BY dn,bin"""
print(con.execute(q).df().to_string(index=False))
