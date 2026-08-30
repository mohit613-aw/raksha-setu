from sqlalchemy import Column, Integer, String, Float, DateTime, Text
from datetime import datetime
from app.database.connection import Base

class Shelter(Base):
    __tablename__ = "shelters"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    location = Column(String, nullable=False)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    capacity = Column(Integer, default=100)
    current_occupancy = Column(Integer, default=0)
    status = Column(String, default="Open")
    contact_person = Column(String, nullable=True)
    contact_phone = Column(String, nullable=True)
    facilities = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
