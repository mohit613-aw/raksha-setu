from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text
from datetime import datetime
from app.database.connection import Base

class FoundSuggestion(Base):
    __tablename__ = "found_suggestions"
    id = Column(Integer, primary_key=True, index=True)
    missing_person_id = Column(Integer, ForeignKey("missing_persons.id"), nullable=False)
    suggested_location = Column(String, nullable=True)
    found_location = Column(String, nullable=True)
    found_date = Column(DateTime, default=datetime.utcnow)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    description = Column(Text, nullable=True)
    notes = Column(Text, nullable=True)
    photo_url = Column(String, nullable=True)
    contact_phone = Column(String, nullable=True)
    submitter_name = Column(String, nullable=True)
    reported_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    status = Column(String, default="PENDING")
    created_at = Column(DateTime, default=datetime.utcnow)
