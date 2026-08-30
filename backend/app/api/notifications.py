from fastapi import APIRouter, Header
from typing import Optional
from app.database.connection import SessionLocal
from app.models.notification import Notification
from app.api.auth import get_current_user_from_header

router = APIRouter(prefix="/notifications", tags=["Notifications"])


@router.get("/")
def get_notifications(authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    with SessionLocal() as db:
        notifs = db.query(Notification).filter(Notification.user_id == user.id).order_by(Notification.id.desc()).all()
        if not notifs:
            # Seed standard alert notification if empty
            sample = Notification(
                user_id=user.id,
                title="Early Warning Network Connected",
                body="You are connected to Raksha Setu 24/7 real-time situational broadcast network.",
                is_read=False
            )
            db.add(sample)
            db.commit()
            db.refresh(sample)
            notifs = [sample]
        return notifs


@router.get("/unread-count")
def unread_count(authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    with SessionLocal() as db:
        c = db.query(Notification).filter(Notification.user_id == user.id, Notification.is_read == False).count()
        return {"unread_count": c}


@router.patch("/{id}/read")
@router.post("/{id}/read")
def mark_single_read(id: int):
    with SessionLocal() as db:
        notif = db.query(Notification).filter(Notification.id == id).first()
        if notif:
            notif.is_read = True
            db.commit()
        return {"status": "ok", "id": id}


@router.patch("/read-all")
@router.post("/mark-all-read")
def mark_all_read(authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    with SessionLocal() as db:
        db.query(Notification).filter(Notification.user_id == user.id).update({"is_read": True})
        db.commit()
        return {"status": "ok"}
