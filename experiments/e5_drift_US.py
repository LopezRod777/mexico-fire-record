# E5: deriva orbital. (a) hora solar local (LST) mediana por satélite y año, pases de día; (b) P(Aqua ve | VIIRS ve, FRP 10-30MW, día) por año.
import duckdb, pandas as pd
con=duckdb.connect()
T="types={'acq_time':'VARCHAR','confidence':'VARCHAR'}"
con.execute(f"CREATE VIEW m AS SELECT * FROM read_csv('data/raw_us/modis/*.csv', union_by_name=true, {T})")
con.execute(f"CREATE VIEW v AS SELECT * FROM read_csv('data/raw_us/viirs-snpp/*.csv', union_by_name=true, {T})")
lst="""((cast(substr(lpad(acq_time,4,'0'),1,2) as int)*60+cast(substr(lpad(acq_time,4,'0'),3,2) as int))/60.0 + longitude/15.0 + 24) % 24"""
q=f"""SELECT year(acq_date::date) yr, satellite, round(median({lst}),2) lst_mediana_h, count(*) n
FROM (SELECT satellite,acq_date,acq_time,longitude,daynight FROM m UNION ALL SELECT satellite,acq_date,acq_time,longitude,daynight FROM v)
WHERE daynight='D' GROUP BY ALL"""
df=con.execute(q).df()
print("(a) Hora solar local mediana, pases de DÍA (horas decimales)")
print(df.pivot(index='yr',columns='satellite',values='lst_mediana_h').round(2).to_string())
con.execute("CREATE VIEW ma AS SELECT * FROM m WHERE satellite='Aqua' AND acq_date>='2018-01-01'")
con.execute("CREATE VIEW vv AS SELECT * FROM v WHERE acq_date>='2018-01-01'")
q2="""WITH a AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d FROM ma WHERE daynight='D' GROUP BY ALL),
b AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, sum(frp) fv FROM vv WHERE daynight='D' GROUP BY ALL HAVING sum(frp)>=10 AND sum(frp)<30)
SELECT year(b.d::date) yr, count(*) celdas, round(avg((a.i IS NOT NULL)::int),3) p_aqua_ve FROM b LEFT JOIN a USING(i,j,d) GROUP BY 1 ORDER BY 1"""
print("\n(b) P(Aqua ve | VIIRS S-NPP ve, FRP 10-30 MW, día) por año")
print(con.execute(q2).df().to_string(index=False))
