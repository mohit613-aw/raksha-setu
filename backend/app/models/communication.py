from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text
from datetime import datetime
from app.database.connection import Base

class CommunicationLog(Base):
    __tablename__ = "communication_logs"
    id = Column(Integer, primary_key=True, index=True)
    recipient_phone = Column(String, nullable=False)
    message_body = Column(Text, nullable=False)
    channel = Column(String, default="SMS")
    status = Column(String, default="Delivered")
    sent_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
