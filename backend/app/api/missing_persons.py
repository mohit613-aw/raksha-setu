import os
import uuid
from datetime import datetime
from fastapi import APIRouter, UploadFile, File, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.missing_person import MissingPerson
from app.models.found_suggestion import FoundSuggestion
from app.models.missing_person_audit_log import MissingPersonAuditLog
from app.config import BASE_DIR
from app.api.auth import get_current_user_from_header

router = APIRouter(prefix="/missing-persons", tags=["Missing Persons"])

STATIC_UPLOADS_DIR = os.path.join(BASE_DIR, "static", "uploads")
os.makedirs(STATIC_UPLOADS_DIR, exist_ok=True)


class MissingPersonCreate(BaseModel):
    full_name: str
    age: Optional[int] = None
    gender: Optional[str] = None
    last_seen_location: str
    last_seen_latitude: Optional[float] = None
    last_seen_longitude: Optional[float] = None
    last_seen_date: Optional[str] = None
    description: Optional[str] = None
    photo_url: Optional[str] = None
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None


class StatusUpdateRequest(BaseModel):
    status: str
    notes: Optional[str] = None


class SightingCreateRequest(BaseModel):
    found_location: Optional[str] = None
    suggested_location: Optional[str] = None
    found_date: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    contact_phone: Optional[str] = None
    photo_url: Optional[str] = None
    notes: Optional[str] = None
    description: Optional[str] = None


def format_missing_person(mp: MissingPerson):
    return {
        "id": mp.id,
        "full_name": mp.full_name,
        "age": mp.age,
        "gender": mp.gender,
        "last_seen_location": mp.last_seen_location,
        "last_seen_latitude": mp.last_seen_latitude,
        "last_seen_longitude": mp.last_seen_longitude,
        "last_seen_date": mp.last_seen_date.isoformat() if mp.last_seen_date else None,
        "description": mp.description,
        "photo_url": mp.photo_url,
        "status": mp.status or "MISSING",
        "reported_by": mp.reported_by,
        "contact_name": mp.contact_name,
        "contact_phone": mp.contact_phone,
        "created_at": mp.created_at.isoformat() if mp.created_at else datetime.utcnow().isoformat()
    }


@router.get("/")
def get_missing_persons(status: Optional[str] = None, search: Optional[str] = None, limit: int = 100):
    with SessionLocal() as db:
        q = db.query(MissingPerson)
        if status and status.strip():
            q = q.filter(MissingPerson.status == status.strip().upper())
        if search and search.strip():
            term = f"%{search.strip()}%"
            q = q.filter((MissingPerson.full_name.ilike(term)) | (MissingPerson.last_seen_location.ilike(term)))
        people = q.order_by(MissingPerson.id.desc()).limit(limit).all()
        return [format_missing_person(mp) for mp in people]


@router.get("/my")
def get_my_missing_persons(authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    with SessionLocal() as db:
        q = db.query(MissingPerson).filter(
            (MissingPerson.reported_by == user.id) |
            (MissingPerson.contact_phone == user.phone_number)
        ).order_by(MissingPerson.id.desc()).all()
        if not q:
            q = db.query(MissingPerson).order_by(MissingPerson.id.desc()).limit(3).all()
        return [format_missing_person(mp) for mp in q]


@router.post("/upload-photo")
async def upload_missing_person_photo(photo: UploadFile = File(...)):
    if not photo or not photo.filename:
        raise HTTPException(status_code=400, detail="No photo provided")
    ext = os.path.splitext(photo.filename)[1] or ".jpg"
    unique_name = f"mp_{uuid.uuid4().hex}{ext}"
    file_path = os.path.join(STATIC_UPLOADS_DIR, unique_name)
    content = await photo.read()
    with open(file_path, "wb") as f:
        f.write(content)
    return {"photo_url": f"/uploads/{unique_name}"}


@router.post("/")
def create_missing_person(data: MissingPersonCreate, authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    seen_date = datetime.utcnow()
    if data.last_seen_date:
        try:
            seen_date = datetime.fromisoformat(data.last_seen_date.replace("Z", "+00:00"))
        except Exception:
            seen_date = datetime.utcnow()

    with SessionLocal() as db:
        mp = MissingPerson(
            full_name=data.full_name,
            age=data.age,
            gender=data.gender,
            last_seen_location=data.last_seen_location,
            last_seen_latitude=data.last_seen_latitude,
            last_seen_longitude=data.last_seen_longitude,
            last_seen_date=seen_date,
            description=data.description,
            photo_url=data.photo_url,
            status="MISSING",
            reported_by=user.id if user else None,
            contact_name=data.contact_name,
            contact_phone=data.contact_phone
        )
        db.add(mp)
        db.commit()
        db.refresh(mp)

        # Create initial audit log
        log = MissingPersonAuditLog(
            missing_person_id=mp.id,
            action="REGISTRATION",
            previous_status="NEW",
            new_status="MISSING",
            notes="Case registered in national disaster database.",
            performed_by=user.id if user else None,
            performed_by_name=user.name if user else "Citizen",
            performed_by_role=user.role if user else "USER"
        )
        db.add(log)
        db.commit()

        return format_missing_person(mp)


@router.get("/{id}")
def get_missing_person(id: int):
    with SessionLocal() as db:
        mp = db.query(MissingPerson).filter(MissingPerson.id == id).first()
        if not mp:
            raise HTTPException(status_code=404, detail="Missing person case not found")
        return format_missing_person(mp)


@router.patch("/{id}/status")
def update_missing_person_status(id: int, data: StatusUpdateRequest, authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    new_st = data.status.strip().upper()

    with SessionLocal() as db:
        mp = db.query(MissingPerson).filter(MissingPerson.id == id).first()
        if not mp:
            raise HTTPException(status_code=404, detail="Missing person case not found")
        
        old_st = mp.status
        mp.status = new_st

        # Write audit log
        log = MissingPersonAuditLog(
            missing_person_id=mp.id,
            action="STATUS_CHANGE",
            previous_status=old_st,
            new_status=new_st,
            notes=data.notes or f"Status changed from {old_st} to {new_st}",
            performed_by=user.id if user else None,
            performed_by_name=user.name if user else "Officer",
            performed_by_role=user.role if user else "AUTHORITY_VERIFIED"
        )
        db.add(log)
        db.commit()
        db.refresh(mp)
        return format_missing_person(mp)


@router.get("/{id}/suggestions")
def get_suggestions_for_person(id: int):
    with SessionLocal() as db:
        suggestions = db.query(FoundSuggestion).filter(FoundSuggestion.missing_person_id == id).order_by(FoundSuggestion.id.desc()).all()
        return [
            {
                "id": s.id,
                "missing_person_id": s.missing_person_id,
                "found_location": s.found_location or s.suggested_location,
                "found_date": s.found_date.isoformat() if s.found_date else s.created_at.isoformat() if s.created_at else datetime.utcnow().isoformat(),
                "latitude": s.latitude,
                "longitude": s.longitude,
                "notes": s.notes or s.description or "Citizen sighting report",
                "photo_url": s.photo_url,
                "contact_phone": s.contact_phone or "+919876543210",
                "submitter_name": s.submitter_name or "Citizen Reporter",
                "status": s.status or "PENDING",
                "created_at": s.created_at.isoformat() if s.created_at else datetime.utcnow().isoformat()
            }
            for s in suggestions
        ]


@router.post("/{id}/suggestions")
def add_suggestion_for_person(id: int, data: SightingCreateRequest, authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    loc = data.found_location or data.suggested_location or "Field Location"
    notes = data.notes or data.description or "Sighting reported"

    f_date = datetime.utcnow()
    if data.found_date:
        try:
            f_date = datetime.fromisoformat(data.found_date.replace("Z", "+00:00"))
        except Exception:
            f_date = datetime.utcnow()

    with SessionLocal() as db:
        s = FoundSuggestion(
            missing_person_id=id,
            found_location=loc,
            suggested_location=loc,
            found_date=f_date,
            latitude=data.latitude,
            longitude=data.longitude,
            notes=notes,
            description=notes,
            photo_url=data.photo_url,
            contact_phone=data.contact_phone or (user.phone_number if user else "+919876543210"),
            submitter_name=user.name if user else "Citizen",
            reported_by=user.id if user else None,
            status="PENDING"
        )
        db.add(s)
        db.commit()
        db.refresh(s)
        return {
            "status": "success",
            "message": "Sighting report submitted successfully",
            "suggestion_id": s.id
        }


@router.get("/{id}/audit-logs")
def get_audit_logs(id: int):
    with SessionLocal() as db:
        logs = db.query(MissingPersonAuditLog).filter(MissingPersonAuditLog.missing_person_id == id).order_by(MissingPersonAuditLog.id.desc()).all()
        return [
            {
                "id": l.id,
                "missing_person_id": l.missing_person_id,
                "action": l.action,
                "previous_status": l.previous_status or "NEW",
                "new_status": l.new_status or "MISSING",
                "notes": l.notes or l.details or "Case registered",
                "performed_by_name": l.performed_by_name or "Command Administrator",
                "performed_by_role": l.performed_by_role or "ADMIN",
                "created_at": l.created_at.isoformat() if l.created_at else datetime.utcnow().isoformat()
            }
            for l in logs
        ]
