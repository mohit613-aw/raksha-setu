import sqlite3
from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker
from app.config import DATABASE_URL

engine = create_engine(
    DATABASE_URL, connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
)

if "sqlite" in DATABASE_URL:
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA cache_size=-64000")
        cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def auto_migrate_sqlite_columns():
    """
    Ensures all columns in registered SQLAlchemy models exist in SQLite database.
    """
    if "sqlite" not in DATABASE_URL:
        return

    db_file = DATABASE_URL.replace("sqlite:///", "")
    try:
        con = sqlite3.connect(db_file)
        cur = con.cursor()
        for table_name, table in Base.metadata.tables.items():
            existing_cols = {c[1] for c in cur.execute(f"PRAGMA table_info({table_name})").fetchall()}
            if not existing_cols:
                continue
            for col in table.columns:
                if col.name not in existing_cols:
                    col_type = str(col.type).upper()
                    if "INT" in col_type or "BOOL" in col_type:
                        sql_type = "INTEGER"
                    elif "FLOAT" in col_type or "REAL" in col_type:
                        sql_type = "REAL"
                    elif "DATETIME" in col_type or "TIMESTAMP" in col_type:
                        sql_type = "DATETIME"
                    else:
                        sql_type = "TEXT"
                    cur.execute(f"ALTER TABLE {table_name} ADD COLUMN {col.name} {sql_type}")
        con.commit()
        con.close()
    except Exception as e:
        pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
