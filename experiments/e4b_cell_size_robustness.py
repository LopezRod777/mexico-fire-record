# E4b: ¿el "Terra-solo" sobrevive a celdas más grandes (tolerancia de geolocalización)? Mismo criterio que e4, solo Terra de día.
import duckdb
con=duckdb.connect()
T="types={'acq_time':'VARCHAR','confidence':'VARCHAR'}"
con.execute(f"CREATE VIEW m AS SELECT * FROM read_csv('data/raw/modis/*.csv', union_by_name=true, {T}) WHERE acq_date>='2012-01-20'")
con.execute(f"CREATE VIEW v AS SELECT * FROM read_csv('data/raw/viirs-snpp/*.csv', union_by_name=true, {T}) WHERE acq_date>='2012-01-20'")
rows=[]
for c in (0.02,0.05,0.1,0.25):
    q=f"""
    WITH t AS (SELECT cast(floor(latitude/{c}) as int) i, cast(floor(longitude/{c}) as int) j, acq_date d, sum(frp) ft FROM m WHERE satellite='Terra' AND daynight='D' GROUP BY ALL HAVING sum(frp)>=30),
    pv AS (SELECT cast(floor(latitude/{c}) as int) i, cast(floor(longitude/{c}) as int) j, acq_date d FROM v WHERE daynight='D' GROUP BY ALL),
    pa AS (SELECT cast(floor(latitude/{c}) as int) i, cast(floor(longitude/{c}) as int) j, acq_date d FROM m WHERE satellite='Aqua' AND daynight='D' GROUP BY ALL)
    SELECT {c} celda, count(*) n_terra_30mw,
      round(1-avg((pv.i IS NOT NULL)::int),3) sin_viirs_tarde,
      round(1-avg((pa.i IS NOT NULL)::int),3) sin_aqua_tarde,
      round(1-avg((pv.i IS NOT NULL OR pa.i IS NOT NULL)::int),3) sin_ninguno_tarde
    FROM t LEFT JOIN pv USING(i,j,d) LEFT JOIN pa USING(i,j,d)"""
    rows.append(con.execute(q).df())
import pandas as pd
print(pd.concat(rows).to_string(index=False))
