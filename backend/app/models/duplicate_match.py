from sqlalchemy import Column, Integer, Float, String, DateTime, ForeignKey, Text
from datetime import datetime
from app.database.connection import Base

class DuplicateMatch(Base):
    __tablename__ = "duplicate_matches"
    id = Column(Integer, primary_key=True, index=True)
    report_id = Column(Integer, ForeignKey("incident_reports.id"), nullable=False)
    matched_report_id = Column(Integer, nullable=True)
    candidate_disaster_id = Column(Integer, nullable=True)
    confidence_score = Column(Float, default=0.85)
    signals_breakdown = Column(Text, nullable=True)
    status = Column(String, default="PENDING")
    created_at = Column(DateTime, default=datetime.utcnow)
