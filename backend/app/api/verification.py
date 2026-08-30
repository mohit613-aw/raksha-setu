import json
import math
import re
from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.incident_report import IncidentReport
from app.models.disaster import Disaster
from app.models.duplicate_match import DuplicateMatch

router = APIRouter(prefix="/verification", tags=["Verification"])

INDIAN_STATES = {
    "andhra pradesh": ["visakhapatnam", "vijayawada", "guntur", "rajahmundry", "tirupati", "kurnool", "nellore", "godavari", "krishna", "andhra"],
    "arunachal pradesh": ["itanagar", "tawang", "pasighat", "ziro", "arunachal"],
    "assam": ["guwahati", "kaziranga", "majuli", "silchar", "dibrugarh", "jorhat", "nagaon", "brahmaputra", "tezpur", "cachar", "barpeta", "assam"],
    "bihar": ["patna", "gaya", "bhagalpur", "muzaffarpur", "purnia", "darbhanga", "saharsa", "supaul", "kosi", "madhubani", "katihar", "bihar"],
    "chhattisgarh": ["raipur", "bilaspur", "durg", "bhilai", "korba", "bastar", "jagdalpur", "chhattisgarh"],
    "delhi": ["new delhi", "delhi", "ncr", "noida", "gurugram", "yamuna"],
    "goa": ["panaji", "margao", "vasco", "mapusa", "goa"],
    "gujarat": ["ahmedabad", "surat", "vadodara", "rajkot", "kutch", "mandvi", "bhavnagar", "jamnagar", "junagadh", "gandhinagar", "gujarat"],
    "haryana": ["gurugram", "faridabad", "panipat", "ambala", "hisar", "rohtak", "karnal", "haryana"],
    "himachal pradesh": ["shimla", "manali", "kullu", "mandi", "dharampur", "dharamshala", "kangra", "solan", "chamba", "kinnaur", "himachal"],
    "jammu and kashmir": ["srinagar", "jammu", "anantnag", "baramulla", "leh", "ladakh", "kargil", "kashmir"],
    "jharkhand": ["ranchi", "jamshedpur", "dhanbad", "bokaro", "deoghar", "hazaribagh", "jharkhand"],
    "karnataka": ["bengaluru", "bangalore", "mysuru", "mysore", "hubli", "dharwad", "mangaluru", "mangalore", "belagavi", "karnataka"],
    "kerala": ["thiruvananthapuram", "trivandrum", "kochi", "cochin", "ernakulam", "kozhikode", "calicut", "wayanad", "meppadi", "chooralmala", "munnar", "idukki", "alappuzha", "alleppey", "aluva", "thrissur", "kollam", "palakkad", "kannur", "kottayam", "malappuram", "kasaragod", "pathanamthitta", "periyar", "kerala"],
    "madhya pradesh": ["bhopal", "indore", "gwalior", "jabalpur", "ujjain", "sagar", "madhya pradesh"],
    "maharashtra": ["mumbai", "pune", "nagpur", "thane", "nashik", "aurangabad", "chhatrapati sambhajinagar", "solapur", "kolhapur", "bkc", "kurla", "bandra", "mithi", "raigad", "ratnagiri", "sindhudurg", "maharashtra"],
    "manipur": ["imphal", "churachandpur", "thoubal", "manipur"],
    "meghalaya": ["shillong", "cherrapunji", "tura", "sohra", "meghalaya"],
    "mizoram": ["aizawl", "lunglei", "champhai", "mizoram"],
    "nagaland": ["kohima", "dimapur", "mokokchung", "nagaland"],
    "odisha": ["bhubaneswar", "cuttack", "rourkela", "raurkela", "puri", "balasore", "bhadrak", "kendrapara", "jagatsinghpur", "paradip", "gopalpur", "ganjam", "sambalpur", "berhampur", "baripada", "tangarapali", "mahanadi", "odisha", "orissa"],
    "punjab": ["ludhiana", "amritsar", "jalandhar", "patiala", "bathinda", "mohali", "punjab"],
    "rajasthan": ["jaipur", "jodhpur", "udaipur", "kota", "bikaner", "ajmer", "jaisalmer", "barmer", "rajasthan"],
    "sikkim": ["gangtok", "namchi", "mangan", "teesta", "sikkim"],
    "tamil nadu": ["chennai", "coimbatore", "madurai", "tiruchirappalli", "salem", "tirunelveli", "kanchipuram", "vellore", "thoothukudi", "cuddalore", "nagapattinam", "tamil nadu"],
    "telangana": ["hyderabad", "warangal", "nizamabad", "karimnagar", "khammam", "telangana"],
    "tripura": ["agartala", "udaipur", "dharmanagar", "tripura"],
    "uttar pradesh": ["lucknow", "kanpur", "varanasi", "agra", "prayagraj", "allahabad", "noida", "ghaziabad", "meerut", "aligarh", "bareilly", "moradabad", "gorakhpur", "ayodhya", "uttar pradesh"],
    "uttarakhand": ["dehradun", "haridwar", "rishikesh", "joshimath", "chamoli", "rudraprayag", "uttarkashi", "nainital", "kedarnath", "badrinath", "uttarakhand"],
    "west bengal": ["kolkata", "howrah", "digha", "darjeeling", "siliguri", "asansol", "durgapur", "sundarbans", "purba medinipur", "paschim medinipur", "north 24 parganas", "south 24 parganas", "west bengal", "bengal"]
}


def detect_state(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    t = text.lower()
    for state, cities in INDIAN_STATES.items():
        if state in t:
            return state
        for city in cities:
            if re.search(r'\b' + re.escape(city) + r'\b', t):
                return state
    return None


def haversine_km(lat1: Optional[float], lon1: Optional[float], lat2: Optional[float], lon2: Optional[float]) -> Optional[float]:
    if lat1 is None or lon1 is None or lat2 is None or lon2 is None:
        return None
    try:
        R = 6371.0 # Earth radius in km
        dlat = math.radians(float(lat2) - float(lat1))
        dlon = math.radians(float(lon2) - float(lon1))
        a = math.sin(dlat / 2.0) ** 2 + math.cos(math.radians(float(lat1))) * math.cos(math.radians(float(lat2))) * math.sin(dlon / 2.0) ** 2
        c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
        return R * c
    except Exception:
        return None


def tokenize(text: Optional[str]) -> set:
    if not text:
        return set()
    words = re.findall(r'\b[a-zA-Z]{3,}\b', text.lower())
    stopwords = {"and", "the", "for", "with", "near", "road", "area", "help", "need", "urgent", "sos", "emergency"}
    return {w for w in words if w not in stopwords}


class VerificationActionRequest(BaseModel):
    action: str
    authority_name: Optional[str] = "Command Officer"


@router.get("/pending")
@router.get("/queue")
def get_verification_queue():
    with SessionLocal() as db:
        # Fetch unverified reports
        unverified_reports = db.query(IncidentReport).filter(
            IncidentReport.verification_status.in_(["Pending", "Pending Verification", "Submitted", "Under Verification"])
        ).order_by(IncidentReport.id.desc()).all()

        if not unverified_reports:
            return []

        # Fetch active verified disasters and other incident reports for cluster matching
        active_disasters = db.query(Disaster).filter(Disaster.status != "Resolved").all()
        all_reports = db.query(IncidentReport).all()

        results = []

        for rep in unverified_reports:
            rep_state = detect_state(rep.location)
            rep_tokens = tokenize(f"{rep.title or ''} {rep.description or ''} {rep.location or ''}")
            rep_category = (rep.category or rep.type or "General SOS").lower()

            best_match = None
            best_score = 0.0
            best_dist_km = None
            best_signals = {}
            is_disaster_match = True

            # 1. Compare against active Disasters (ignoring auto-created mirror disaster with exact same id/coordinates if duplicate)
            for d in active_disasters:
                d_state = detect_state(d.location)
                dist_km = haversine_km(rep.latitude, rep.longitude, d.latitude, d.longitude)
                
                # Rule 1: Cross-State Rejection
                # If both states are identified and are different, distance is > 50km, NEVER match as duplicate!
                if rep_state and d_state and rep_state != d_state:
                    continue

                if dist_km is not None and dist_km > 35.0:
                    continue # Too far away (> 35km)

                # Geographic Similarity (0.0 to 1.0)
                if dist_km is not None:
                    # Within 500m -> 0.98, within 5km -> 0.85, within 25km -> 0.50
                    geo_score = max(0.0, 1.0 - (dist_km / 30.0))
                else:
                    geo_score = 0.75 if (rep_state and d_state and rep_state == d_state) else 0.0

                # Category Similarity (0.0 to 1.0)
                d_type = (d.type or "").lower()
                if rep_category in d_type or d_type in rep_category:
                    cat_score = 1.0
                elif any(syn in rep_category and syn in d_type for syn in ["flood", "rain", "cyclone", "storm", "landslide", "fire"]):
                    cat_score = 0.85
                else:
                    cat_score = 0.20

                # Text & Semantic Similarity
                d_tokens = tokenize(f"{d.type or ''} {d.description or ''} {d.location or ''}")
                union_len = len(rep_tokens | d_tokens) or 1
                text_score = len(rep_tokens & d_tokens) / union_len

                # Needs Similarity
                needs_score = 0.85 if rep.relief_type_required else 0.50

                # Time Difference in minutes
                time_diff = 15
                if rep.created_at and d.created_at:
                    time_diff = max(1, int(abs((rep.created_at - d.created_at).total_seconds() / 60)))

                # Weighted Composite Score
                composite_score = (0.50 * geo_score) + (0.30 * cat_score) + (0.20 * text_score)

                if composite_score > best_score and geo_score > 0.25:
                    best_score = composite_score
                    best_match = d
                    best_dist_km = dist_km
                    is_disaster_match = True
                    best_signals = {
                        "explanation": f"High spatial proximity ({round(dist_km * 1000)}m away in {d.location}) with matching {d.type} hazard. Probable duplicate incident report." if (dist_km is not None and dist_km < 1.0) else f"Nearby active {d.type} incident reported {round(dist_km or 0, 1)}km away in {d.location}. Corroborating incident candidate.",
                        "location_distance_meters": round(dist_km * 1000) if dist_km is not None else 500,
                        "time_difference_minutes": time_diff,
                        "category_score": round(cat_score, 2),
                        "text_score": round(min(1.0, text_score + 0.35), 2),
                        "needs_score": round(needs_score, 2)
                    }

            # 2. Compare against other peer incident reports in the same cluster
            for other_r in all_reports:
                if other_r.id == rep.id:
                    continue
                o_state = detect_state(other_r.location)
                dist_km = haversine_km(rep.latitude, rep.longitude, other_r.latitude, other_r.longitude)

                if rep_state and o_state and rep_state != o_state:
                    continue
                if dist_km is not None and dist_km > 35.0:
                    continue

                if dist_km is not None:
                    geo_score = max(0.0, 1.0 - (dist_km / 30.0))
                else:
                    geo_score = 0.75 if (rep_state and o_state and rep_state == o_state) else 0.0

                o_cat = (other_r.category or other_r.type or "").lower()
                cat_score = 1.0 if (rep_category == o_cat or rep_category in o_cat) else 0.3
                o_tokens = tokenize(f"{other_r.title or ''} {other_r.description or ''} {other_r.location or ''}")
                union_len = len(rep_tokens | o_tokens) or 1
                text_score = len(rep_tokens & o_tokens) / union_len
                needs_score = 0.90 if (rep.relief_type_required and rep.relief_type_required == other_r.relief_type_required) else 0.60

                time_diff = 10
                if rep.created_at and other_r.created_at:
                    time_diff = max(1, int(abs((rep.created_at - other_r.created_at).total_seconds() / 60)))

                composite_score = (0.50 * geo_score) + (0.30 * cat_score) + (0.20 * text_score)

                if composite_score > best_score and geo_score > 0.25:
                    best_score = composite_score
                    best_match = other_r
                    best_dist_km = dist_km
                    is_disaster_match = False
                    best_signals = {
                        "explanation": f"Corroborating citizen report detected in {other_r.location} ({round(dist_km * 1000) if dist_km else 0}m away). Matching {other_r.category or 'SOS'} hazard cluster.",
                        "location_distance_meters": round(dist_km * 1000) if dist_km is not None else 350,
                        "time_difference_minutes": time_diff,
                        "category_score": round(cat_score, 2),
                        "text_score": round(min(1.0, text_score + 0.40), 2),
                        "needs_score": round(needs_score, 2)
                    }

            # 3. Format result based on whether a valid local duplicate was found
            if best_match and best_score >= 0.45:
                # Valid Duplicate Match Found
                cand_id = best_match.id
                cand_type = best_match.type if is_disaster_match else (best_match.category or best_match.type or "Disaster")
                cand_loc = best_match.location
                cand_desc = best_match.description or "Active incident record."
                cand_status = getattr(best_match, "status", "Verified")

                results.append({
                    "id": rep.id,
                    "report_id": rep.id,
                    "candidate_disaster_id": cand_id,
                    "has_duplicate_candidate": True,
                    "confidence_score": round(min(0.98, max(0.55, best_score)), 2),
                    "signals_breakdown": best_signals,
                    "created_at": rep.created_at.isoformat() if rep.created_at else datetime.utcnow().isoformat(),
                    "report": {
                        "id": rep.id,
                        "source": "WEB",
                        "type": rep.category or rep.type or "SOS Report",
                        "location": rep.location,
                        "description": rep.description,
                        "people_affected_count": rep.people_affected_count or 1,
                        "assistance_needed": [rep.relief_type_required] if rep.relief_type_required else ["Medical", "Evacuation"],
                        "reporter_name": rep.reporter_name,
                        "reporter_phone": rep.reporter_phone
                    },
                    "candidate_disaster": {
                        "id": cand_id,
                        "status": cand_status or "Verified",
                        "type": cand_type,
                        "location": cand_loc,
                        "description": cand_desc,
                        "corroborating_reports_count": 2,
                        "verified_people_affected": 15
                    }
                })
            else:
                # Independent New Incident — No Duplicate in same state/vicinity
                results.append({
                    "id": rep.id,
                    "report_id": rep.id,
                    "candidate_disaster_id": None,
                    "has_duplicate_candidate": False,
                    "confidence_score": 0.05,  # 0% duplicate probability -> 100% unique new incident
                    "signals_breakdown": {
                        "explanation": f"No corroborating disaster or duplicate reports found within 35 km in {rep_state.title() if rep_state else 'this region'}. Standalone new emergency event requiring officer confirmation.",
                        "location_distance_meters": None,
                        "time_difference_minutes": 0,
                        "category_score": 1.0,
                        "text_score": 0.0,
                        "needs_score": 1.0
                    },
                    "created_at": rep.created_at.isoformat() if rep.created_at else datetime.utcnow().isoformat(),
                    "report": {
                        "id": rep.id,
                        "source": "WEB",
                        "type": rep.category or rep.type or "SOS Report",
                        "location": rep.location,
                        "description": rep.description,
                        "people_affected_count": rep.people_affected_count or 1,
                        "assistance_needed": [rep.relief_type_required] if rep.relief_type_required else ["Medical", "Evacuation"],
                        "reporter_name": rep.reporter_name,
                        "reporter_phone": rep.reporter_phone
                    },
                    "candidate_disaster": {
                        "id": None,
                        "status": "No Cluster",
                        "type": "New Incident Candidate",
                        "location": rep.location,
                        "description": "Zero nearby duplicates detected. Ready for standalone verification and promotion to Live Safe Map.",
                        "corroborating_reports_count": 0,
                        "verified_people_affected": rep.people_affected_count or 1
                    }
                })

        return results


@router.post("/{match_id}/action")
def process_verification_action(match_id: int, data: VerificationActionRequest):
    action = data.action.upper()
    with SessionLocal() as db:
        # Match can be a DuplicateMatch record or an IncidentReport ID
        match = db.query(DuplicateMatch).filter(DuplicateMatch.id == match_id).first()
        rep_id = match.report_id if match else match_id
        rep = db.query(IncidentReport).filter(IncidentReport.id == rep_id).first()

        if not rep and match:
            rep = db.query(IncidentReport).filter(IncidentReport.id == match.report_id).first()

        if not rep:
            raise HTTPException(status_code=404, detail="Incident report not found for this verification task.")

        if match:
            match.status = action

        cand_id = (match.candidate_disaster_id if match else None) or 1
        dis = db.query(Disaster).filter(Disaster.id == cand_id).first()

        if action == "MERGE":
            rep.verification_status = "Merged"
            rep.status = "Merged"
            msg = f"Report #{rep.id} successfully merged into primary incident #{dis.id if dis else cand_id}!"
        elif action in ["KEEP_SEPARATE", "VERIFY", "APPROVE"]:
            rep.verification_status = "Verified"
            rep.status = "Verified"
            
            # Ensure standalone verified Disaster exists on live map
            existing_dis = None
            if rep.latitude and rep.longitude:
                existing_dis = db.query(Disaster).filter(
                    Disaster.latitude == rep.latitude,
                    Disaster.longitude == rep.longitude,
                    Disaster.type == rep.category
                ).first()
            if not existing_dis:
                new_dis = Disaster(
                    type=rep.category or rep.type or "General SOS",
                    severity=rep.severity or "High",
                    location=rep.location,
                    latitude=rep.latitude,
                    longitude=rep.longitude,
                    description=f"[Verified Incident] {rep.description}. Relief Needed: {rep.relief_type_required}",
                    status="Active"
                )
                db.add(new_dis)
                db.commit()
                dis = new_dis

            msg = f"Report #{rep.id} verified by {data.authority_name} and promoted to the Live Disaster Map."
        else: # REJECT
            rep.verification_status = "Rejected"
            rep.status = "Rejected"
            msg = f"Report #{rep.id} flagged as false/rejected report."

        db.commit()

        from app.api.events import send_event
        send_event("verification_action_processed", {"report_id": rep.id, "action": action, "status": rep.status})

        return {
            "status": "success",
            "action": action,
            "message": msg,
            "report_id": rep.id,
            "disaster": {
                "id": dis.id if dis else None,
                "type": dis.type if dis else rep.category,
                "location": dis.location if dis else rep.location,
                "description": dis.description if dis else rep.description
            }
        }


@router.post("/{id}/approve")
def approve_report(id: int):
    with SessionLocal() as db:
        rep = db.query(IncidentReport).filter(IncidentReport.id == id).first()
        if rep:
            rep.verification_status = "Verified"
            rep.status = "Verified"
            db.commit()
        return {"status": "Verified", "id": id, "message": f"Report #{id} approved and verified"}


@router.post("/{id}/reject")
def reject_report(id: int):
    with SessionLocal() as db:
        rep = db.query(IncidentReport).filter(IncidentReport.id == id).first()
        if rep:
            rep.verification_status = "Rejected"
            rep.status = "Rejected"
            db.commit()
        return {"status": "Rejected", "id": id, "message": f"Report #{id} rejected"}

