from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from datetime import datetime
from app.database.connection import Base

class Resource(Base):
    __tablename__ = "resources"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=True)
    item_name = Column(String, nullable=False)
    category = Column(String, default="General")
    quantity_available = Column(Integer, default=0)
    quantity_requested = Column(Integer, default=0)
    delivery_location = Column(String, nullable=True)
    status = Column(String, default="Available")
    requested_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
