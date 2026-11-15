import argparse

from common import PROCESSED, RAW, connect


def build(region):
    output = PROCESSED / region
    output.mkdir(parents=True, exist_ok=True)
    con = connect(region)
    cutoff = RAW[region][2]
    con.execute("""
        CREATE TEMP VIEW all_detections AS
        SELECT satellite, satellite AS sensor, daynight, acq_date, acq_time,
               latitude, longitude, frp, version FROM m
        UNION ALL
        SELECT satellite, 'SNPP', daynight, acq_date, acq_time,
               latitude, longitude, frp, version FROM v
    """)
    con.execute("""
        CREATE TEMP TABLE lst_by_year AS
        WITH times AS (
            SELECT satellite, year(acq_date) AS year,
                   ((CAST(left(lpad(acq_time, 4, '0'), 2) AS INTEGER) * 60
                     + CAST(right(lpad(acq_time, 4, '0'), 2) AS INTEGER)) / 60.0
                     + longitude / 15.0 + 24) % 24 AS lst
            FROM all_detections WHERE daynight = 'D'
        )
        SELECT satellite, year, round(median(lst), 2) AS lst_median, count(*) AS n
        FROM times GROUP BY ALL ORDER BY satellite, year
    """)
    con.execute("COPY lst_by_year TO ? (HEADER, DELIMITER ',')", [str(output / "lst_by_year.csv")])
    con.execute("""
        CREATE TEMP TABLE ratio_by_year AS
        WITH cell_days AS (
            SELECT DISTINCT sensor, daynight, year(acq_date) AS year, acq_date,
                   CAST(floor(latitude / 0.05) AS INTEGER) AS cell_i,
                   CAST(floor(longitude / 0.05) AS INTEGER) AS cell_j
            FROM all_detections WHERE acq_date >= ?
        ), counts AS (
            SELECT year, daynight, sensor, count(*) AS n_cell_days
            FROM cell_days GROUP BY ALL
        )
        SELECT year, daynight,
               max(CASE WHEN sensor = 'Terra' THEN n_cell_days END) AS terra_cell_days,
               max(CASE WHEN sensor = 'Aqua' THEN n_cell_days END) AS aqua_cell_days,
               max(CASE WHEN sensor = 'SNPP' THEN n_cell_days END) AS snpp_cell_days,
               max(CASE WHEN sensor = 'Terra' THEN n_cell_days END) * 1.0 /
                   max(CASE WHEN sensor = 'SNPP' THEN n_cell_days END) AS terra_snpp,
               max(CASE WHEN sensor = 'Aqua' THEN n_cell_days END) * 1.0 /
                   max(CASE WHEN sensor = 'SNPP' THEN n_cell_days END) AS aqua_snpp
        FROM counts GROUP BY year, daynight ORDER BY year, daynight
    """, [cutoff])
    con.execute("COPY ratio_by_year TO ? (HEADER, DELIMITER ',')", [str(output / "ratio_by_year.csv")])
    con.execute("""
        CREATE TEMP TABLE versions_by_year AS
        SELECT satellite, year(acq_date) AS year,
               version, count(*) AS n
        FROM all_detections GROUP BY ALL ORDER BY satellite, year, version
    """)
    con.execute("COPY versions_by_year TO ? (HEADER, DELIMITER ',')", [str(output / "versions_by_year.csv")])
    con.execute("""
        CREATE TEMP TABLE overlap_probability AS
        WITH cells AS (
            SELECT sensor, daynight, acq_date,
                   CAST(floor(latitude / 0.02) AS INTEGER) AS cell_i,
                   CAST(floor(longitude / 0.02) AS INTEGER) AS cell_j,
                   sum(frp) AS frp_sum
            FROM all_detections
            WHERE sensor IN ('Aqua', 'SNPP') AND acq_date >= ?
            GROUP BY ALL
        ), paired AS (
            SELECT v.daynight, v.frp_sum,
                   a0.acq_date IS NOT NULL AS same_day,
                   a1.acq_date IS NOT NULL AS next_day,
                   am1.acq_date IS NOT NULL AS previous_day
            FROM cells v
            LEFT JOIN cells a0 ON a0.sensor = 'Aqua' AND a0.daynight = v.daynight
                AND a0.cell_i = v.cell_i AND a0.cell_j = v.cell_j
                AND a0.acq_date = v.acq_date
            LEFT JOIN cells a1 ON a1.sensor = 'Aqua' AND a1.daynight = v.daynight
                AND a1.cell_i = v.cell_i AND a1.cell_j = v.cell_j
                AND a1.acq_date = v.acq_date + INTERVAL 1 DAY
            LEFT JOIN cells am1 ON am1.sensor = 'Aqua' AND am1.daynight = v.daynight
                AND am1.cell_i = v.cell_i AND am1.cell_j = v.cell_j
                AND am1.acq_date = v.acq_date - INTERVAL 1 DAY
            WHERE v.sensor = 'SNPP'
        ), binned AS (
            SELECT daynight,
                   CASE WHEN frp_sum < 3 THEN '<3'
                        WHEN frp_sum < 10 THEN '3-10'
                        WHEN frp_sum < 30 THEN '10-30'
                        ELSE '30+' END AS bin,
                   same_day, next_day, previous_day
            FROM paired
        )
        SELECT daynight, bin, count(*) AS n_celdas_viirs,
               avg(same_day::INTEGER) AS p_mismo_dia,
               avg(next_day::INTEGER) AS p_dia_siguiente,
               avg(previous_day::INTEGER) AS p_dia_previo
        FROM binned GROUP BY ALL ORDER BY daynight, bin
    """, [cutoff])
    con.execute("COPY overlap_probability TO ? (HEADER, DELIMITER ',')", [str(output / "overlap_probability.csv")])
    con.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=("mx", "us"), required=True)
    build(parser.parse_args().region)
