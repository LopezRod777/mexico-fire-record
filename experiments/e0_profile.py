import duckdb
con=duckdb.connect()
T="types={'acq_time':'VARCHAR','confidence':'VARCHAR'}"
con.execute(f"CREATE VIEW m AS SELECT * FROM read_csv('data/raw/modis/*.csv', union_by_name=true, {T})")
con.execute(f"CREATE VIEW v AS SELECT * FROM read_csv('data/raw/viirs-snpp/*.csv', union_by_name=true, {T})")
print("filas MODIS", con.execute("select count(*) from m").fetchone()[0], "VIIRS", con.execute("select count(*) from v").fetchone()[0])
for t in ('m','v'):
    print(con.execute(f"select satellite,instrument,count(*) n,min(acq_date) d0,max(acq_date) d1 from {t} group by 1,2 order by 1").df().to_string(index=False))
df=con.execute("""select satellite||'/'||instrument s, cast(substr(lpad(acq_time,4,'0'),1,2) as int) h, count(*) n
 from (select satellite,instrument,acq_time from m union all select satellite,instrument,acq_time from v) group by 1,2""").df()
print(df.pivot(index='h',columns='s',values='n').fillna(0).astype(int).to_string())
