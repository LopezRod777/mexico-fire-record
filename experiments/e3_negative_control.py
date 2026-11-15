# E3: control negativo temporal. P(Aqua en la celda) emparejando VIIRS con Aqua del MISMO día vs del DÍA SIGUIENTE (misma celda, mismo turno).
import duckdb
con=duckdb.connect()
T="types={'acq_time':'VARCHAR','confidence':'VARCHAR'}"
con.execute(f"CREATE VIEW m AS SELECT * FROM read_csv('data/raw/modis/*.csv', union_by_name=true, {T}) WHERE satellite='Aqua' AND acq_date>='2012-01-20'")
con.execute(f"CREATE VIEW v AS SELECT * FROM read_csv('data/raw/viirs-snpp/*.csv', union_by_name=true, {T}) WHERE acq_date>='2012-01-20'")
q="""
WITH a AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn FROM m GROUP BY ALL),
b AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn, sum(frp) fv FROM v GROUP BY ALL),
r AS (SELECT b.*, (a0.i IS NOT NULL) mismo, (a1.i IS NOT NULL) siguiente, (am.i IS NOT NULL) previo
      FROM b LEFT JOIN a a0 ON a0.i=b.i AND a0.j=b.j AND a0.d=b.d AND a0.dn=b.dn
             LEFT JOIN a a1 ON a1.i=b.i AND a1.j=b.j AND a1.d=b.d+INTERVAL 1 DAY AND a1.dn=b.dn
             LEFT JOIN a am ON am.i=b.i AND am.j=b.j AND am.d=b.d-INTERVAL 1 DAY AND am.dn=b.dn)
SELECT dn, CASE WHEN fv<3 THEN '1 <3MW' WHEN fv<10 THEN '2 3-10' WHEN fv<30 THEN '3 10-30' ELSE '4 30+' END bin, count(*) n,
 round(avg(mismo::int),3) p_mismo_dia, round(avg(siguiente::int),3) p_dia_siguiente, round(avg(previo::int),3) p_dia_previo,
 round(avg(mismo::int)/nullif(avg(siguiente::int),0),2) razon_mismo_vs_sig
FROM r GROUP BY ALL ORDER BY dn,bin"""
print(con.execute(q).df().to_string(index=False))
