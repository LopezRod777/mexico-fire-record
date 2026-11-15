export function versionPeriods(rows){
  const bySatellite=new Map();
  for(const row of rows){
    let years=bySatellite.get(row.satellite);
    if(!years)bySatellite.set(row.satellite,years=new Map());
    const current=years.get(row.year);
    if(!current||row.n>current.n)years.set(row.year,row);
  }
  const periods=[];
  for(const [satellite,years] of bySatellite){
    const dominant=[...years].sort(([a],[b])=>a-b);
    let period=null;
    for(const [year,row] of dominant){
      if(period&&year===period.to+1&&row.version===period.version)period.to=year;
      else{period={satellite,version:row.version,from:year,to:year};periods.push(period);}
    }
  }
  return periods;
}
