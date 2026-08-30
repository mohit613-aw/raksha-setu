from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text
from datetime import datetime
from app.database.connection import Base

class MissingPersonAuditLog(Base):
    __tablename__ = "missing_person_audit_logs"
    id = Column(Integer, primary_key=True, index=True)
    missing_person_id = Column(Integer, ForeignKey("missing_persons.id"), nullable=False)
    action = Column(String, nullable=True)
    previous_status = Column(String, nullable=True)
    new_status = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    details = Column(Text, nullable=True)
    performed_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    performed_by_name = Column(String, nullable=True)
    performed_by_role = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
