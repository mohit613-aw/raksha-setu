from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text
from datetime import datetime
from app.database.connection import Base

class AuthorityApplication(Base):
    __tablename__ = "authority_applications"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    organization_name = Column(String, nullable=True)
    organization = Column(String, nullable=True)
    designation = Column(String, nullable=False)
    official_id_badge_number = Column(String, nullable=True)
    official_email = Column(String, nullable=True)
    purpose_justification = Column(Text, nullable=True)
    reason = Column(String, nullable=True)
    status = Column(String, default="PENDING")
    review_notes = Column(Text, nullable=True)
    reviewed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
