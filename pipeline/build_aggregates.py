import argparse

from common import PROCESSED, connect


def build(region):
    output = PROCESSED / region
    output.mkdir(parents=True, exist_ok=True)
    con = connect(region)
    con.execute("""
        CREATE TEMP VIEW detections AS
        SELECT satellite AS sensor, daynight, acq_date,
               CAST(floor(latitude / 0.05) AS INTEGER) AS cell_i,
               CAST(floor(longitude / 0.05) AS INTEGER) AS cell_j,
               frp
        FROM m
        UNION ALL
        SELECT 'SNPP', daynight, acq_date,
               CAST(floor(latitude / 0.05) AS INTEGER),
               CAST(floor(longitude / 0.05) AS INTEGER), frp
        FROM v
    """)
    con.execute("""
        CREATE TEMP TABLE cell_day AS
        SELECT sensor, daynight, cell_i, cell_j, acq_date,
               count(*) AS n_det, sum(frp) AS frp_sum
        FROM detections
        GROUP BY ALL
    """)
    con.execute("COPY cell_day TO ? (FORMAT PARQUET)", [str(output / "cell_day.parquet")])
    con.execute("""
        CREATE TEMP TABLE month_cell025 AS
        SELECT sensor, daynight,
               CAST(year(acq_date) AS INTEGER) AS year,
               CAST(month(acq_date) AS INTEGER) AS month,
               CAST(floor(cell_i / 5.0) AS INTEGER) AS cell_i,
               CAST(floor(cell_j / 5.0) AS INTEGER) AS cell_j,
               count(*) AS n_cell_days, sum(n_det) AS n_det,
               sum(frp_sum) AS frp_sum
        FROM cell_day
        GROUP BY ALL
    """)
    con.execute("COPY month_cell025 TO ? (FORMAT PARQUET)", [str(output / "month_cell025.parquet")])
    con.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", choices=("mx", "us"), required=True)
    build(parser.parse_args().region)
