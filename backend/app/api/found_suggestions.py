import os
import uuid
from datetime import datetime
from fastapi import APIRouter, UploadFile, File, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.found_suggestion import FoundSuggestion
from app.config import BASE_DIR
from app.api.auth import get_current_user_from_header

router = APIRouter(prefix="/found-suggestions", tags=["Found Suggestions"])

STATIC_UPLOADS_DIR = os.path.join(BASE_DIR, "static", "uploads")
os.makedirs(STATIC_UPLOADS_DIR, exist_ok=True)


class FoundSuggestionCreate(BaseModel):
    missing_person_id: int
    suggested_location: Optional[str] = None
    found_location: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    description: Optional[str] = None
    notes: Optional[str] = None
    photo_url: Optional[str] = None
    contact_phone: Optional[str] = None


@router.get("/")
def get_suggestions():
    with SessionLocal() as db:
        suggestions = db.query(FoundSuggestion).order_by(FoundSuggestion.id.desc()).all()
        return [
            {
                "id": s.id,
                "missing_person_id": s.missing_person_id,
                "found_location": s.found_location or s.suggested_location,
                "suggested_location": s.suggested_location or s.found_location,
                "found_date": s.found_date.isoformat() if s.found_date else (s.created_at.isoformat() if s.created_at else datetime.utcnow().isoformat()),
                "latitude": s.latitude,
                "longitude": s.longitude,
                "notes": s.notes or s.description or "Citizen sighting report",
                "description": s.description or s.notes or "Citizen sighting report",
                "photo_url": s.photo_url,
                "contact_phone": s.contact_phone or "+919876543210",
                "submitter_name": s.submitter_name or "Citizen Reporter",
                "status": s.status or "PENDING",
                "created_at": s.created_at.isoformat() if s.created_at else datetime.utcnow().isoformat()
            }
            for s in suggestions
        ]


@router.get("/my")
def get_my_suggestions(authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    with SessionLocal() as db:
        suggestions = db.query(FoundSuggestion).filter(
            (FoundSuggestion.reported_by == user.id) |
            (FoundSuggestion.contact_phone == user.phone_number)
        ).order_by(FoundSuggestion.id.desc()).all()

        if not suggestions:
            suggestions = db.query(FoundSuggestion).order_by(FoundSuggestion.id.desc()).limit(3).all()

        return [
            {
                "id": s.id,
                "missing_person_id": s.missing_person_id,
                "found_location": s.found_location or s.suggested_location,
                "suggested_location": s.suggested_location or s.found_location,
                "found_date": s.found_date.isoformat() if s.found_date else (s.created_at.isoformat() if s.created_at else datetime.utcnow().isoformat()),
                "latitude": s.latitude,
                "longitude": s.longitude,
                "notes": s.notes or s.description or "Citizen sighting report",
                "description": s.description or s.notes or "Citizen sighting report",
                "photo_url": s.photo_url,
                "contact_phone": s.contact_phone or "+919876543210",
                "submitter_name": s.submitter_name or "Citizen Reporter",
                "status": s.status or "PENDING",
                "created_at": s.created_at.isoformat() if s.created_at else datetime.utcnow().isoformat()
            }
            for s in suggestions
        ]


@router.post("/upload-photo")
async def upload_sighting_photo(photo: UploadFile = File(...)):
    if not photo or not photo.filename:
        raise HTTPException(status_code=400, detail="No photo provided")
    ext = os.path.splitext(photo.filename)[1] or ".jpg"
    unique_name = f"sighting_{uuid.uuid4().hex}{ext}"
    file_path = os.path.join(STATIC_UPLOADS_DIR, unique_name)
    content = await photo.read()
    with open(file_path, "wb") as f:
        f.write(content)
    return {"photo_url": f"/uploads/{unique_name}"}


@router.post("/")
def create_suggestion(data: FoundSuggestionCreate, authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    loc = data.found_location or data.suggested_location or "Location unlisted"
    notes = data.notes or data.description or "Sighting reported"

    with SessionLocal() as db:
        s = FoundSuggestion(
            missing_person_id=data.missing_person_id,
            found_location=loc,
            suggested_location=loc,
            found_date=datetime.utcnow(),
            latitude=data.latitude,
            longitude=data.longitude,
            notes=notes,
            description=notes,
            photo_url=data.photo_url,
            contact_phone=data.contact_phone or (user.phone_number if user else "+919876543210"),
            submitter_name=user.name if user else "Citizen Reporter",
            reported_by=user.id if user else None,
            status="PENDING"
        )
        db.add(s)
        db.commit()
        db.refresh(s)
        return s


@router.patch("/{id}/status")
def update_suggestion_status(id: int, data: dict):
    with SessionLocal() as db:
        s = db.query(FoundSuggestion).filter(FoundSuggestion.id == id).first()
        if not s:
            raise HTTPException(status_code=404, detail="Sighting not found")
        if "status" in data:
            s.status = data["status"]
            db.commit()
            db.refresh(s)
        return s
