from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text
from datetime import datetime
from app.database.connection import Base

class MissingPerson(Base):
    __tablename__ = "missing_persons"
    id = Column(Integer, primary_key=True, index=True)
    full_name = Column(String, nullable=False)
    age = Column(Integer, nullable=True)
    gender = Column(String, nullable=True)
    last_seen_location = Column(String, nullable=False)
    last_seen_latitude = Column(Float, nullable=True)
    last_seen_longitude = Column(Float, nullable=True)
    last_seen_date = Column(DateTime, default=datetime.utcnow)
    description = Column(Text, nullable=True)
    photo_url = Column(String, nullable=True)
    status = Column(String, default="MISSING")
    reported_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    contact_name = Column(String, nullable=True)
    contact_phone = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
