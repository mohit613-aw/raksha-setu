from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text
from datetime import datetime
from app.database.connection import Base

class IncidentReport(Base):
    __tablename__ = "incident_reports"
    id = Column(Integer, primary_key=True, index=True)
    reporter_name = Column(String, nullable=False)
    reporter_phone = Column(String, nullable=False)
    title = Column(String, nullable=True)
    description = Column(Text, nullable=False)
    location = Column(String, nullable=False)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    relief_type_required = Column(String, nullable=True)
    people_affected_count = Column(Integer, default=1)
    severity = Column(String, default="High")
    category = Column(String, default="General")
    type = Column(String, default="General SOS")
    image_url = Column(String, nullable=True)
    reporter_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    verification_status = Column(String, default="Submitted")
    status = Column(String, default="Submitted")
    ai_needs_assessment = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
