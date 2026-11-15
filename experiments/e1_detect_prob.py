# E1: par casi simultáneo Aqua(MODIS) vs S-NPP(VIIRS). Celda 0.02° (~2.2 km) x día x día/noche.
# P(Aqua detecta | VIIRS detecta) según FRP total de VIIRS en la celda, y a la inversa.
import duckdb
con=duckdb.connect()
T="types={'acq_time':'VARCHAR','confidence':'VARCHAR'}"
con.execute(f"CREATE VIEW m AS SELECT * FROM read_csv('data/raw/modis/*.csv', union_by_name=true, {T}) WHERE satellite='Aqua' AND acq_date>='2012-01-20'")
con.execute(f"CREATE VIEW v AS SELECT * FROM read_csv('data/raw/viirs-snpp/*.csv', union_by_name=true, {T}) WHERE acq_date>='2012-01-20'")
q="""
WITH a AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn, count(*) na, sum(frp) fa FROM m GROUP BY ALL),
b AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn, count(*) nv, sum(frp) fv FROM v GROUP BY ALL),
j AS (SELECT coalesce(a.i,b.i) i, coalesce(a.j,b.j) j, coalesce(a.d,b.d) d, coalesce(a.dn,b.dn) dn, coalesce(na,0) na, coalesce(fa,0) fa, coalesce(nv,0) nv, coalesce(fv,0) fv FROM a FULL JOIN b USING (i,j,d,dn))
SELECT 'VIIRS->MODIS' dir, dn,
  CASE WHEN fv<1 THEN '0 <1MW' WHEN fv<3 THEN '1 1-3' WHEN fv<10 THEN '2 3-10' WHEN fv<30 THEN '3 10-30' ELSE '4 30+' END bin,
  count(*) celdas, round(avg((na>0)::int),3) p_modis_ve
FROM j WHERE nv>0 GROUP BY ALL ORDER BY dn,bin
"""
print(con.execute(q).df().to_string(index=False))
q2=q.replace("fv<1 THEN '0 <1MW'","fa<10 THEN '0 <10MW'").replace("fv<3 THEN '1 1-3'","fa<30 THEN '1 10-30'").replace("fv<10 THEN '2 3-10'","fa<100 THEN '2 30-100'").replace("fv<30 THEN '3 10-30'","fa<300 THEN '3 100-300'").replace("'VIIRS->MODIS'","'MODIS->VIIRS'").replace("(na>0)","(nv>0)").replace("WHERE nv>0","WHERE na>0").replace("p_modis_ve","p_viirs_ve")
print(con.execute(q2).df().to_string(index=False))
