from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime
from datetime import datetime
from app.database.connection import Base

class Alert(Base):
    __tablename__ = "alerts"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    message = Column(Text, nullable=False)
    severity = Column(String, default="Warning")
    target_region = Column(String, default="National")
    hazard_type = Column(String, default="General")
    is_active = Column(Boolean, default=True)
    source = Column(String, default="Command Operations")
    created_at = Column(DateTime, default=datetime.utcnow)
