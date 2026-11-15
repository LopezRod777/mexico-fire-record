# E6: ¿se erosiona el registro de Terra por su deriva hacia la mañana? Razón de celdas-día (0.05°) detectadas, normalizada por S-NPP (estable ~13:15 LST), por año, día y noche.
import duckdb, pandas as pd
con=duckdb.connect()
T="types={'acq_time':'VARCHAR','confidence':'VARCHAR'}"
con.execute(f"CREATE VIEW m AS SELECT * FROM read_csv('data/raw_us/modis/*.csv', union_by_name=true, {T}) WHERE acq_date>='2018-01-01'")
con.execute(f"CREATE VIEW v AS SELECT * FROM read_csv('data/raw_us/viirs-snpp/*.csv', union_by_name=true, {T}) WHERE acq_date>='2018-01-01'")
q="""WITH c AS (
 SELECT year(acq_date::date) yr, satellite sat, daynight dn, count(DISTINCT (cast(floor(latitude/0.05) as int), cast(floor(longitude/0.05) as int), acq_date)) celdas_dia FROM m GROUP BY ALL
 UNION ALL
 SELECT year(acq_date::date), 'SNPP', daynight, count(DISTINCT (cast(floor(latitude/0.05) as int), cast(floor(longitude/0.05) as int), acq_date)) FROM v GROUP BY ALL)
SELECT yr, dn, sat, celdas_dia FROM c"""
df=con.execute(q).df()
p=df.pivot_table(index=['dn','yr'],columns='sat',values='celdas_dia')
p['Terra/SNPP']=(p.Terra/p.SNPP).round(3); p['Aqua/SNPP']=(p.Aqua/p.SNPP).round(3)
print(p[['Terra/SNPP','Aqua/SNPP']].unstack(0).to_string())
