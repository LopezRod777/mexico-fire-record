import duckdb, numpy as np, pandas as pd
con=duckdb.connect()
T="types={'acq_time':'VARCHAR','confidence':'VARCHAR'}"
con.execute(f"CREATE VIEW m AS SELECT * FROM read_csv('data/raw/modis/*.csv', union_by_name=true, {T}) WHERE satellite='Aqua' AND acq_date>='2012-01-20'")
con.execute(f"CREATE VIEW v AS SELECT * FROM read_csv('data/raw/viirs-snpp/*.csv', union_by_name=true, {T}) WHERE acq_date>='2012-01-20'")
# --- T3: desfase de tiempo Aqua vs S-NPP en celdas 0.02° donde ambos detectan el mismo día/turno
q="""WITH a AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn,
  min(cast(substr(lpad(acq_time,4,'0'),1,2) as int)*60+cast(substr(lpad(acq_time,4,'0'),3,2) as int)) ta FROM m GROUP BY ALL),
b AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn,
  min(cast(substr(lpad(acq_time,4,'0'),1,2) as int)*60+cast(substr(lpad(acq_time,4,'0'),3,2) as int)) tv FROM v GROUP BY ALL)
SELECT dn, count(*) n, quantile_cont(tv-ta,0.1) p10, median(tv-ta) med, quantile_cont(tv-ta,0.9) p90, round(avg((abs(tv-ta)<=30)::int),3) frac_dentro_30min
FROM a JOIN b USING(i,j,d,dn) GROUP BY dn"""
print("T3 desfase VIIRS(S-NPP) - MODIS(Aqua), minutos:"); print(con.execute(q).df().to_string(index=False))
# --- T1: "MODIS virtual": predecir celdas-día Aqua por bloque 1° y mes desde VIIRS, entrenando 2012-2022, probando 2023-2025
q="""WITH a AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn, 1 na FROM m GROUP BY ALL),
b AS (SELECT cast(floor(latitude/0.02) as int) i, cast(floor(longitude/0.02) as int) j, acq_date d, daynight dn, sum(frp) fv FROM v GROUP BY ALL)
SELECT b.i,b.j,b.d,b.dn,b.fv, coalesce(a.na,0) hit FROM b LEFT JOIN a USING(i,j,d,dn)"""
df=con.execute(q).df()
df['d']=pd.to_datetime(df['d']); df['yr']=df.d.dt.year; df['mo']=df.d.dt.month
df['bin']=pd.cut(df.fv,[0,1,3,10,30,100,1e9],labels=False)
df['bi']=(df.i*0.02).apply(np.floor).astype(int); df['bj']=(df.j*0.02).apply(np.floor).astype(int)
tr=df[df.yr<=2022]; te=df[df.yr>=2023].copy()
p=tr.groupby(['dn','bin']).hit.mean().rename('p').reset_index()
te=te.merge(p,on=['dn','bin'],how='left')
k=tr.hit.sum()/len(tr)  # ingenuo: una sola tasa global
te['naive']=k
g=te.groupby(['bi','bj','yr','mo']).agg(actual=('hit','sum'),curve=('p','sum'),naive=('naive','sum')).reset_index()
g=g[g.actual>=5]
def rep(name,pred):
    ape=(abs(pred-g.actual)/g.actual); r=np.corrcoef(np.log1p(pred),np.log1p(g.actual))[0,1]
    print(f"{name:28s} MAPE mediana={ape.median():.3f}  MAPE media={ape.mean():.3f}  corr(log)={r:.3f}  sesgo total={(pred.sum()/g.actual.sum()-1):+.3f}")
print(f"\nT1 bloques 1°-mes en test 2023-25 con >=5 celdas-día Aqua reales: {len(g)}")
rep("ingenuo (tasa global)",g.naive); rep("curva P(MODIS|FRP VIIRS)",g.curve)
print("\nsesgo por año (curva):"); 
h=te.groupby(['yr']).agg(actual=('hit','sum'),curve=('p','sum')).assign(ratio=lambda x:x.curve/x.actual); print(h.round(3).to_string())
