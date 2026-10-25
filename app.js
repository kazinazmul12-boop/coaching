/**
 * CoachingDesk - Coaching Management System Engine
 * Integrates Firebase Auth (Gmail Login) & Firestore Real-time Database
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { 
    getAuth, 
    signInWithPopup, 
    GoogleAuthProvider, 
    signInAnonymously, 
    signInWithCustomToken, 
    signOut, 
    onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    deleteDoc, 
    onSnapshot, 
    collection, 
    addDoc 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// -------------------------------------------------------------
// 1. FIREBASE INITIALIZATION & STATE
// -------------------------------------------------------------
const appId = typeof __app_id !== 'undefined' ? __app_id : 'coachingdesk-app';
const firebaseConfig = typeof __firebase_config !== 'undefined' 
    ? JSON.parse(__firebase_config) 
    : {
        apiKey: "AIzaSyDemoConfigKeyForProductionUseOnly",
        authDomain: "coachingdesk-demo.firebaseapp.com",
        projectId: "coachingdesk-demo",
        storageBucket: "coachingdesk-demo.appspot.com",
        messagingSenderId: "123456789",
        appId: "1:123456789:web:abcdef123456"
    };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Application State
let currentUser = null;
let currentStudent = null;
let isMasterAdmin = false;
let isAuthSignUp = false;
let authRole = 'teacher';
let isProUser = false;
const FREE_STUDENT_LIMIT = 5;

// Data Collections (Synchronized with Firestore)
let students = [];
let attendanceRecords = {};
let feePayments = {};
let classroomSettings = { className: '', classCode: '', classLink: '', driveLink: '' };
let announcements = [];
let paymentRequests = [];

// Date Helpers
const todayStr = new Date().toISOString().split('T')[0];
const currentMonthStr = new Date().toISOString().slice(0, 7);

// Unsubscribe handles for Firestore snapshot listeners
let unsubscribeStudents = null;
let unsubscribeAttendance = null;
let unsubscribeFees = null;
let unsubscribeClassroom = null;
let unsubscribeAnnouncements = null;
let unsubscribePayments = null;

// Admin Password configuration
const DEFAULT_ADMIN_PASS = "adminpassword123";
function getMasterAdminPassword() {
    return localStorage.getItem("coachingdesk_admin_pass") || DEFAULT_ADMIN_PASS;
}

const PAYMENT_NUMBERS = {
    bKash: "01742415244 (bKash Personal)",
    Nagad: "01674723704 (Nagad Personal)",
    Rocket: "01674723704 (Rocket Personal)"
};

// -------------------------------------------------------------
// 2. AUTHENTICATION (GMAIL & ANONYMOUS)
// -------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    // Set default values for inputs
    const attDateInput = document.getElementById('attendanceDate');
    const feeMonthInput = document.getElementById('feeMonthPicker');
    if (attDateInput) attDateInput.value = todayStr;
    if (feeMonthInput) feeMonthInput.value = currentMonthStr;

    // Firebase Auth State Observer
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            if (user.email) {
                const emailEl = document.getElementById('teacherEmailDisplay');
                if (emailEl) emailEl.innerText = user.email;
            }
            // Bind Firebase listeners once authenticated
            setupFirestoreListeners();
        } else {
            currentUser = null;
            // Attempt auto authentication (Custom Token or Anonymous)
            try {
                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await signInWithCustomToken(auth, __initial_auth_token);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (err) {
                console.error("Auth initialization failed:", err);
            }
        }
    });
});

// Gmail / Google Sign-In Handler
window.signInWithGoogle = async function() {
    const provider = new GoogleAuthProvider();
    try {
        const result = await signInWithPopup(auth, provider);
        currentUser = result.user;
        
        const emailEl = document.getElementById('teacherEmailDisplay');
        if (emailEl) emailEl.innerText = currentUser.email || "Google User";

        window.closeAuthModal();
        window.showView('appDashboardView');
        window.showCustomAlert(`স্বাগতম! ${currentUser.displayName || currentUser.email} হিসেবে সাইন ইন হয়েছে`, "success");
    } catch (error) {
        console.error("Google Auth Error:", error);
        window.showCustomAlert("গুগল দিয়ে সাইন ইন করতে ব্যর্থ হয়েছে: " + error.message, "error");
    }
};

window.logoutUser = async function() {
    try {
        await signOut(auth);
        currentUser = null;
        detachFirestoreListeners();
        window.showView('homeView');
        window.showCustomAlert("সফলভাবে লগআউট করা হয়েছে", "info");
    } catch (err) {
        console.error("Logout error:", err);
    }
};

// -------------------------------------------------------------
// 3. FIRESTORE REAL-TIME SYNCHRONIZATION
// -------------------------------------------------------------

function getPublicDocRef(collectionName, docId) {
    return doc(db, 'artifacts', appId, 'public', 'data', collectionName, docId);
}

function getPublicCollRef(collectionName) {
    return collection(db, 'artifacts', appId, 'public', 'data', collectionName);
}

function getUserCollRef(collectionName) {
    const uid = auth.currentUser?.uid || 'anonymous';
    return collection(db, 'artifacts', appId, 'users', uid, collectionName);
}

function getUserDocRef(collectionName, docId) {
    const uid = auth.currentUser?.uid || 'anonymous';
    return doc(db, 'artifacts', appId, 'users', uid, collectionName, docId);
}

function setupFirestoreListeners() {
    if (!auth.currentUser) return;
    const uid = auth.currentUser.uid;

    // 1. Listen for Students
    const studentsRef = getUserCollRef('students');
    unsubscribeStudents = onSnapshot(studentsRef, (snapshot) => {
        students = [];
        snapshot.forEach(docSnap => {
            students.push({ id: docSnap.id, ...docSnap.data() });
        });
        window.renderAll();
    }, (err) => console.error("Students Listener Error:", err));

    // 2. Listen for Attendance
    const attRef = getUserDocRef('attendance', 'records');
    unsubscribeAttendance = onSnapshot(attRef, (docSnap) => {
        attendanceRecords = docSnap.exists() ? docSnap.data() : {};
        window.renderAttendance();
        window.renderMetrics();
    }, (err) => console.error("Attendance Listener Error:", err));

    // 3. Listen for Fees
    const feesRef = getUserDocRef('fees', 'records');
    unsubscribeFees = onSnapshot(feesRef, (docSnap) => {
        feePayments = docSnap.exists() ? docSnap.data() : {};
        window.renderFees();
        window.renderMetrics();
    }, (err) => console.error("Fees Listener Error:", err));

    // 4. Listen for Classroom Info
    const classRef = getUserDocRef('classroom', 'info');
    unsubscribeClassroom = onSnapshot(classRef, (docSnap) => {
        if (docSnap.exists()) {
            classroomSettings = docSnap.data();
            window.renderClassroomHub();
        }
    }, (err) => console.error("Classroom Listener Error:", err));

    // 5. Listen for Classroom Announcements
    const annRef = getUserCollRef('announcements');
    unsubscribeAnnouncements = onSnapshot(annRef, (snapshot) => {
        announcements = [];
        snapshot.forEach(docSnap => {
            announcements.push({ id: docSnap.id, ...docSnap.data() });
        });
        // Sort announcements by newest first
        announcements.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        window.renderClassroomHub();
    }, (err) => console.error("Announcements Listener Error:", err));

    // 6. Listen for Payment Requests (Public collection for Master Admin)
    const payRef = getPublicCollRef('payments');
    unsubscribePayments = onSnapshot(payRef, (snapshot) => {
        paymentRequests = [];
        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            paymentRequests.push({ id: docSnap.id, ...data });
            
            // Check if current user's request has been approved
            if (data.userId === uid && data.status === 'approved') {
                isProUser = true;
            }
        });
        window.renderPlanBadge();
        if (isMasterAdmin) {
            window.renderAdminDashboard();
        }
    }, (err) => console.error("Payments Listener Error:", err));
}

function detachFirestoreListeners() {
    if (unsubscribeStudents) unsubscribeStudents();
    if (unsubscribeAttendance) unsubscribeAttendance();
    if (unsubscribeFees) unsubscribeFees();
    if (unsubscribeClassroom) unsubscribeClassroom();
    if (unsubscribeAnnouncements) unsubscribeAnnouncements();
    if (unsubscribePayments) unsubscribePayments();
}

// -------------------------------------------------------------
// 4. NAVIGATION & VIEW LOGIC
// -------------------------------------------------------------
window.showView = function(viewId) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById(viewId);
    if (target) target.classList.remove('hidden');
};

window.scrollToSection = function(id) {
    window.showView('homeView');
    setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
};

window.switchTab = function(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    
    // Reset all tab button styles
    ['Attendance', 'Fees', 'Classroom', 'Students'].forEach(t => {
        const btn = document.getElementById(`tab${t}Btn`);
        if (btn) {
            btn.className = "flex-1 sm:flex-none px-4 py-2.5 text-center font-semibold rounded-lg text-slate-600 hover:text-indigo-600 transition-all flex items-center justify-center gap-2 text-sm md:text-base";
        }
    });

    const activeBtn = document.getElementById(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Btn`);
    if (activeBtn) {
        activeBtn.className = "flex-1 sm:flex-none px-4 py-2.5 text-center font-semibold rounded-lg text-indigo-600 bg-indigo-50 transition-all flex items-center justify-center gap-2 text-sm md:text-base";
    }

    const activeTab = document.getElementById(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (activeTab) activeTab.classList.remove('hidden');
};

window.showCustomAlert = function(msg, type = 'info') {
    const box = document.getElementById('alertBox');
    const icon = document.getElementById('alertIcon');
    const text = document.getElementById('alertMessage');

    if (!box || !icon || !text) return;

    box.className = "p-4 rounded-xl flex items-center justify-between shadow-sm transition-all duration-300 ";
    if (type === 'success') {
        box.classList.add('bg-emerald-50', 'text-emerald-800', 'border', 'border-emerald-200');
        icon.className = "fa-solid fa-circle-check text-emerald-600 text-xl";
    } else if (type === 'error') {
        box.classList.add('bg-rose-50', 'text-rose-800', 'border', 'border-rose-200');
        icon.className = "fa-solid fa-circle-xmark text-rose-600 text-xl";
    } else if (type === 'warning') {
        box.classList.add('bg-amber-50', 'text-amber-800', 'border', 'border-amber-200');
        icon.className = "fa-solid fa-triangle-exclamation text-amber-600 text-xl";
    } else {
        box.classList.add('bg-indigo-50', 'text-indigo-800', 'border', 'border-indigo-200');
        icon.className = "fa-solid fa-circle-info text-indigo-600 text-xl";
    }

    text.innerText = msg;
    box.classList.remove('hidden');
    setTimeout(() => { window.dismissAlert(); }, 5000);
};

window.dismissAlert = function() {
    document.getElementById('alertBox')?.classList.add('hidden');
};

// -------------------------------------------------------------
// 5. AUTH MODALS & USER HANDLING
// -------------------------------------------------------------
window.openAuthModal = function(mode, role) {
    isAuthSignUp = (mode === 'signup');
    window.switchAuthRole(role);
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
};

window.closeAuthModal = function() {
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

window.switchAuthRole = function(role) {
    authRole = role;
    const tTab = document.getElementById('authTabTeacher');
    const sTab = document.getElementById('authTabStudent');
    const tSec = document.getElementById('teacherAuthSection');
    const sSec = document.getElementById('studentAuthSection');

    if (role === 'teacher') {
        if (tTab) tTab.className = "flex-1 py-2 text-center rounded-lg bg-white shadow text-indigo-600 transition";
        if (sTab) sTab.className = "flex-1 py-2 text-center rounded-lg text-slate-600 transition";
        if (tSec) tSec.classList.remove('hidden');
        if (sSec) sSec.classList.add('hidden');
        updateAuthTitle();
    } else {
        if (sTab) sTab.className = "flex-1 py-2 text-center rounded-lg bg-white shadow text-emerald-600 transition";
        if (tTab) tTab.className = "flex-1 py-2 text-center rounded-lg text-slate-600 transition";
        if (sSec) sSec.classList.remove('hidden');
        if (tSec) tSec.classList.add('hidden');
        
        const titleEl = document.getElementById('authModalTitle');
        const subEl = document.getElementById('authModalSubtitle');
        if (titleEl) titleEl.innerText = "ছাত্র পোর্টালে ঢুকুন";
        if (subEl) subEl.innerText = "শিক্ষক নিবন্ধিত রোল ও ফোন নম্বর ব্যবহার করুন";
    }
};

function updateAuthTitle() {
    const titleEl = document.getElementById('authModalTitle');
    const subEl = document.getElementById('authModalSubtitle');
    const btnEl = document.getElementById('authSubmitBtn');
    const toggleEl = document.getElementById('authToggleText');

    if (isAuthSignUp) {
        if (titleEl) titleEl.innerText = "নতুন শিক্ষক রেজিস্ট্রেশন";
        if (subEl) subEl.innerText = "ফ্রি একাউন্ট খুলে এখনই শুরু করুন";
        if (btnEl) btnEl.innerText = "রেজিস্টার করুন";
        if (toggleEl) toggleEl.innerHTML = `ইতিমধ্যে একাউন্ট আছে? <button onclick="window.toggleAuthMode()" class="text-indigo-600 font-bold hover:underline">সাইন ইন করুন</button>`;
    } else {
        if (titleEl) titleEl.innerText = "শিক্ষক পোর্টালে সাইন ইন";
        if (subEl) subEl.innerText = "কোচিং ড্যাশবোর্ডে প্রবেশ করতে তথ্য দিন";
        if (btnEl) btnEl.innerText = "সাইন ইন";
        if (toggleEl) toggleEl.innerHTML = `নতুন শিক্ষক? <button onclick="window.toggleAuthMode()" class="text-indigo-600 font-bold hover:underline">ফ্রি রেজিস্টার করুন</button>`;
    }
}

window.toggleAuthMode = function() {
    isAuthSignUp = !isAuthSignUp;
    updateAuthTitle();
};

window.handleEmailAuth = function(e) {
    e.preventDefault();
    const email = document.getElementById('authEmail').value.trim();
    currentUser = auth.currentUser || { email, uid: 't_' + btoa(email).substring(0, 8) };
    
    window.closeAuthModal();
    const emailEl = document.getElementById('teacherEmailDisplay');
    if (emailEl) emailEl.innerText = email;
    
    window.showView('appDashboardView');
    window.renderAll();
    window.showCustomAlert("শিক্ষক হিসেবে সাইন ইন সফল হয়েছে!", "success");
};

window.handleStudentLogin = function(e) {
    e.preventDefault();
    const rollInput = document.getElementById('stLoginRoll').value.trim();
    const phoneInput = document.getElementById('stLoginPhone').value.trim();

    const match = students.find(s => 
        (String(s.roll) === rollInput || s.uniqueId === rollInput) && 
        String(s.phone) === phoneInput
    );

    if (match) {
        currentStudent = match;
        window.closeAuthModal();
        window.showView('studentDashboardView');
        window.renderStudentPortal();
        window.showCustomAlert(`স্বাগতম, ${match.name}!`, "success");
    } else {
        window.showCustomAlert("শিক্ষার্থীর তথ্য মেলেনি! সঠিক রোল ও ফোন নম্বর দিন।", "error");
    }
};

window.logoutStudent = function() {
    currentStudent = null;
    window.showView('homeView');
    window.showCustomAlert("ছাত্র পোর্টাল থেকে লগআউট হয়েছে", "info");
};

// -------------------------------------------------------------
// 6. STUDENT MANAGEMENT (FIRESTORE)
// -------------------------------------------------------------
window.handleAddStudent = async function(e) {
    e.preventDefault();
    if (!auth.currentUser) return;

    if (!isProUser && students.length >= FREE_STUDENT_LIMIT) {
        window.showCustomAlert("ফ্রি প্ল্যানে সর্বোচ্চ ৫ জন ছাত্র যোগ করা সম্ভব। Pro প্যাকেজে আপগ্রেড করুন!", "warning");
        window.openProPaymentModal();
        return;
    }

    const editId = document.getElementById('studentEditId').value;
    const roll = document.getElementById('studentRoll').value.trim();
    const name = document.getElementById('studentName').value.trim();
    const batch = document.getElementById('studentBatch').value.trim();
    const fee = Number(document.getElementById('studentFee').value);
    const phone = document.getElementById('studentPhone').value.trim();

    const uniqueId = `st_${phone.replace(/\D/g,'')}_${roll}`;
    const studentData = { roll, name, batch, fee, phone, uniqueId, updatedAt: Date.now() };

    try {
        if (editId) {
            const docRef = getUserDocRef('students', editId);
            await updateDoc(docRef, studentData);
            window.showCustomAlert("শিক্ষার্থীর তথ্য আপডেট করা হয়েছে!", "success");
        } else {
            const collRef = getUserCollRef('students');
            await addDoc(collRef, studentData);
            window.showCustomAlert("নতুন শিক্ষার্থী ভর্তি সফল হয়েছে!", "success");
        }
        window.resetStudentForm();
    } catch (err) {
        console.error("Error saving student:", err);
        window.showCustomAlert("শিক্ষার্থীর তথ্য সেভ করতে সমস্যা হয়েছে!", "error");
    }
};

window.editStudent = function(id) {
    const s = students.find(item => item.id === id);
    if (!s) return;

    document.getElementById('studentEditId').value = s.id;
    document.getElementById('studentRoll').value = s.roll;
    document.getElementById('studentName').value = s.name;
    document.getElementById('studentBatch').value = s.batch;
    document.getElementById('studentFee').value = s.fee;
    document.getElementById('studentPhone').value = s.phone;

    document.getElementById('studentFormTitle').innerHTML = `<i class="fa-solid fa-user-pen text-indigo-600"></i> শিক্ষার্থী আপডেট`;
    document.getElementById('submitStudentBtn').innerText = `আপডেট করুন`;
    document.getElementById('cancelEditBtn').classList.remove('hidden');
};

window.deleteStudent = async function(id) {
    if (!auth.currentUser) return;
    try {
        const docRef = getUserDocRef('students', id);
        await deleteDoc(docRef);
        window.showCustomAlert("শিক্ষার্থী মুছে ফেলা হয়েছে", "info");
    } catch (err) {
        console.error("Error deleting student:", err);
    }
};

window.resetStudentForm = function() {
    const form = document.getElementById('addStudentForm');
    if (form) form.reset();
    document.getElementById('studentEditId').value = '';
    document.getElementById('studentFormTitle').innerHTML = `<i class="fa-solid fa-user-plus text-indigo-600"></i> নতুন শিক্ষার্থী ভর্তি`;
    document.getElementById('submitStudentBtn').innerText = `সংরক্ষণ করুন`;
    document.getElementById('cancelEditBtn').classList.add('hidden');
};

// -------------------------------------------------------------
// 7. ATTENDANCE MANAGEMENT (FIRESTORE)
// -------------------------------------------------------------
window.toggleAttendance = async function(studentId, date) {
    if (!auth.currentUser) return;
    
    const updated = { ...attendanceRecords };
    if (!updated[date]) updated[date] = {};
    
    const currentStatus = updated[date][studentId] || 'absent';
    updated[date][studentId] = (currentStatus === 'present') ? 'absent' : 'present';

    try {
        const attRef = getUserDocRef('attendance', 'records');
        await setDoc(attRef, updated, { merge: true });
    } catch (err) {
        console.error("Error toggling attendance:", err);
    }
};

window.markAllAttendance = async function(status) {
    if (!auth.currentUser) return;
    const date = document.getElementById('attendanceDate')?.value || todayStr;
    const updated = { ...attendanceRecords };
    if (!updated[date]) updated[date] = {};

    students.forEach(s => {
        updated[date][s.id] = status;
    });

    try {
        const attRef = getUserDocRef('attendance', 'records');
        await setDoc(attRef, updated, { merge: true });
        window.showCustomAlert(`সকলের উপস্থিতি '${status === 'present' ? 'উপস্থিত' : 'অনুপস্থিত'}' চিহ্নিত করা হয়েছে`, "success");
    } catch (err) {
        console.error("Error updating all attendance:", err);
    }
};

// -------------------------------------------------------------
// 8. FEES MANAGEMENT (FIRESTORE)
// -------------------------------------------------------------
window.openFeeModal = function(studentId, name, currentFee) {
    document.getElementById('modalStudentId').value = studentId;
    document.getElementById('modalStudentInfo').innerText = `শিক্ষার্থী: ${name} (মাসিক ফি: ৳${currentFee})`;
    document.getElementById('modalAmount').value = feePayments[studentId] || currentFee;

    const modal = document.getElementById('paymentModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
};

window.closeFeeModal = function() {
    const modal = document.getElementById('paymentModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

window.submitPaymentModal = async function(e) {
    e.preventDefault();
    if (!auth.currentUser) return;

    const sId = document.getElementById('modalStudentId').value;
    const amount = Number(document.getElementById('modalAmount').value);

    const updated = { ...feePayments, [sId]: amount };

    try {
        const feesRef = getUserDocRef('fees', 'records');
        await setDoc(feesRef, updated, { merge: true });
        window.closeFeeModal();
        window.showCustomAlert("ফি জমা তথ্য সফলভাবে সংরক্ষন করা হয়েছে!", "success");
    } catch (err) {
        console.error("Error submitting fee payment:", err);
    }
};

// -------------------------------------------------------------
// 9. GOOGLE CLASSROOM HUB & ANNOUNCEMENTS
// -------------------------------------------------------------
window.handleSaveClassroomInfo = async function(e) {
    e.preventDefault();
    if (!auth.currentUser) return;

    const className = document.getElementById('gcClassName').value.trim();
    const classCode = document.getElementById('gcClassCode').value.trim();
    const classLink = document.getElementById('gcClassLink').value.trim();
    const driveLink = document.getElementById('gcDriveLink').value.trim();

    const data = { className, classCode, classLink, driveLink, updatedAt: Date.now() };

    try {
        const classRef = getUserDocRef('classroom', 'info');
        await setDoc(classRef, data, { merge: true });
        window.showCustomAlert("গুগল ক্লাসরুম লিংক সফলভাবে সেভ হয়েছে!", "success");
    } catch (err) {
        console.error("Error saving classroom info:", err);
    }
};

window.handlePostAnnouncement = async function(e) {
    e.preventDefault();
    if (!auth.currentUser) return;

    const title = document.getElementById('postTitle').value.trim();
    const content = document.getElementById('postContent').value.trim();
    const link = document.getElementById('postLink').value.trim();

    try {
        const annColl = getUserCollRef('announcements');
        await addDoc(annColl, {
            title,
            content,
            link,
            createdAt: Date.now()
        });

        document.getElementById('postTitle').value = '';
        document.getElementById('postContent').value = '';
        document.getElementById('postLink').value = '';
        window.showCustomAlert("নতুন নোটিশ সফলভাবে প্রকাশ করা হয়েছে!", "success");
    } catch (err) {
        console.error("Error posting announcement:", err);
    }
};

window.deleteAnnouncement = async function(id) {
    if (!auth.currentUser) return;
    try {
        const annRef = getUserDocRef('announcements', id);
        await deleteDoc(annRef);
        window.showCustomAlert("নোটিশ মুছে ফেলা হয়েছে", "info");
    } catch (err) {
        console.error("Error deleting announcement:", err);
    }
};

// -------------------------------------------------------------
// 10. PRO PAYMENT & MASTER ADMIN HANDLING
// -------------------------------------------------------------
window.openProPaymentModal = function() {
    const modal = document.getElementById('proPaymentModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
};

window.closeProPaymentModal = function() {
    const modal = document.getElementById('proPaymentModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

window.selectPaymentMethod = function(method) {
    document.getElementById('selectedPayMethod').value = method;
    const numDisplay = document.getElementById('paymentNumberDisplay');
    if (numDisplay) {
        numDisplay.innerText = `${method} Number: ${PAYMENT_NUMBERS[method]}`;
    }

    ['bKash', 'Nagad', 'Rocket'].forEach(m => {
        const btn = document.getElementById(`btnPay${m}`);
        if (btn) {
            if (m === method) {
                btn.className = "pay-method-btn border-2 border-indigo-500 bg-indigo-50 text-indigo-700 p-2.5 rounded-xl text-xs font-bold flex flex-col items-center justify-center gap-1 transition";
            } else {
                btn.className = "pay-method-btn border-2 border-slate-200 hover:border-slate-300 p-2.5 rounded-xl text-xs font-bold text-slate-700 flex flex-col items-center justify-center gap-1 transition";
            }
        }
    });
};

window.submitProPayment = async function(e) {
    e.preventDefault();
    if (!auth.currentUser) return;

    const method = document.getElementById('selectedPayMethod').value;
    const phone = document.getElementById('payPhone').value.trim();
    const trxId = document.getElementById('payTrxId').value.trim().toUpperCase();
    const teacherEmail = currentUser.email || 'teacher@coachingdesk.com';

    const payData = {
        userId: auth.currentUser.uid,
        teacherEmail,
        method,
        phone,
        trxId,
        status: 'pending',
        createdAt: Date.now()
    };

    try {
        const payColl = getPublicCollRef('payments');
        await addDoc(payColl, payData);
        window.closeProPaymentModal();
        window.showCustomAlert("আপনার পেমেন্ট ভেরিফিকেশন রিকোয়েস্ট সাবমিট হয়েছে! অ্যাডমিন অতি শীঘ্রই অনুমোদন করবেন।", "success");
    } catch (err) {
        console.error("Error submitting payment:", err);
    }
};

window.openAdminModal = function() {
    const modal = document.getElementById('adminLoginModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
};

window.closeAdminModal = function() {
    const modal = document.getElementById('adminLoginModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
};

window.handleAdminLogin = function(e) {
    e.preventDefault();
    const u = document.getElementById('adminUsername').value.trim();
    const p = document.getElementById('adminPassword').value;

    if (u === 'admin' && p === getMasterAdminPassword()) {
        isMasterAdmin = true;
        window.closeAdminModal();
        window.showView('masterAdminDashboardView');
        window.renderAdminDashboard();
        window.showCustomAlert("মাস্টার অ্যাডমিন লগইন সফল!", "success");
    } else {
        window.showCustomAlert("ভুল অ্যাডমিন ইউজারনেম অথবা সিকিউরিটি পাসওয়ার্ড!", "error");
    }
};

window.logoutAdmin = function() {
    isMasterAdmin = false;
    window.showView('homeView');
    window.showCustomAlert("অ্যাডমিন প্যানেল থেকে লগআউট করা হয়েছে", "info");
};

window.handleMasterPasswordChange = function(e) {
    e.preventDefault();
    const currentPassInput = document.getElementById('currentMasterPass').value;
    const newPassInput = document.getElementById('newMasterPass').value;

    if (currentPassInput !== getMasterAdminPassword()) {
        window.showCustomAlert("আপনার প্রবেশ করানো বর্তমান পাসওয়ার্ডটি সঠিক নয়!", "error");
        return;
    }

    if (newPassInput.length < 6) {
        window.showCustomAlert("পাসওয়ার্ড ন্যূনতম ৬ অক্ষরের হতে হবে!", "warning");
        return;
    }

    localStorage.setItem("coachingdesk_admin_pass", newPassInput);
    document.getElementById('currentMasterPass').value = '';
    document.getElementById('newMasterPass').value = '';
    window.showCustomAlert("মাস্টার অ্যাডমিন পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে!", "success");
};

window.handleVerifyPayment = async function(payId, newStatus) {
    if (!auth.currentUser) return;
    try {
        const payDocRef = getPublicDocRef('payments', payId);
        await updateDoc(payDocRef, { status: newStatus });
        window.showCustomAlert(`পেমেন্ট স্থিতি '${newStatus === 'approved' ? 'অনুমোদিত (Pro)' : 'বাতিল'}' করা হয়েছে`, "info");
    } catch (err) {
        console.error("Error verifying payment:", err);
    }
};

// -------------------------------------------------------------
// 11. RENDERING FUNCTIONS
// -------------------------------------------------------------
window.renderAll = function() {
    window.renderPlanBadge();
    window.renderMetrics();
    window.renderStudentsList();
    window.renderAttendance();
    window.renderFees();
    window.renderClassroomHub();
};

window.renderPlanBadge = function() {
    const badge = document.getElementById('userPlanBadge');
    const banner = document.getElementById('packageNoticeBanner');
    const limitCounter = document.getElementById('studentLimitCounter');
    const count = students.length;

    if (limitCounter) {
        limitCounter.innerText = `${count}/${isProUser ? '∞' : FREE_STUDENT_LIMIT} জন`;
    }

    if (isProUser) {
        if (badge) badge.innerText = `Pro Plan (আনলিমিটেড)`;
        if (banner) banner.classList.add('hidden');
    } else {
        if (badge) badge.innerText = `Free Plan (${count}/${FREE_STUDENT_LIMIT})`;
        if (banner && count >= FREE_STUDENT_LIMIT) {
            banner.classList.remove('hidden');
        } else if (banner) {
            banner.classList.add('hidden');
        }
    }
};

window.renderMetrics = function() {
    let totalColl = 0;
    let totalD = 0;
    let dueCount = 0;

    students.forEach(s => {
        const paid = Number(feePayments[s.id] || 0);
        const fee = Number(s.fee || 0);
        totalColl += paid;
        const due = Math.max(0, fee - paid);
        totalD += due;
        if (due > 0) dueCount++;
    });

    const colEl = document.getElementById('totalCollection');
    const dueEl = document.getElementById('totalDue');
    const dueCntEl = document.getElementById('dueStudentsCount');

    if (colEl) colEl.innerText = `৳ ${totalColl}`;
    if (dueEl) dueEl.innerText = `৳ ${totalD}`;
    if (dueCntEl) dueCntEl.innerText = `${dueCount} জন শিক্ষার্থীর বাকি`;
};

window.renderStudentsList = function() {
    const tbody = document.getElementById('studentListTableBody');
    if (!tbody) return;

    const search = document.getElementById('studentSearchInput')?.value.toLowerCase() || '';
    const filtered = students.filter(s => 
        s.name.toLowerCase().includes(search) || 
        String(s.roll).includes(search) || 
        (s.uniqueId && s.uniqueId.toLowerCase().includes(search))
    );

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">কোনো শিক্ষার্থী পাওয়া যায়নি</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(s => `
        <tr class="hover:bg-slate-50 transition">
            <td class="p-3 font-mono text-xs text-indigo-600 font-bold">${s.uniqueId || '-'}</td>
            <td class="p-3 font-semibold text-slate-800">${s.roll}</td>
            <td class="p-3 font-bold text-slate-900">${s.name}</td>
            <td class="p-3 text-slate-600">${s.batch}</td>
            <td class="p-3 text-slate-600">${s.phone}</td>
            <td class="p-3 text-slate-800 font-semibold">৳ ${s.fee}</td>
            <td class="p-3 text-center space-x-1">
                <button onclick="window.editStudent('${s.id}')" class="text-indigo-600 hover:text-indigo-800 p-1.5 rounded transition"><i class="fa-solid fa-pen"></i></button>
                <button onclick="window.deleteStudent('${s.id}')" class="text-rose-500 hover:text-rose-700 p-1.5 rounded transition"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
};

window.renderAttendance = function() {
    const tbody = document.getElementById('attendanceTableBody');
    if (!tbody) return;

    const date = document.getElementById('attendanceDate')?.value || todayStr;
    const records = attendanceRecords[date] || {};

    let presentCount = 0;
    students.forEach(s => {
        if (records[s.id] === 'present') presentCount++;
    });

    const attDisp = document.getElementById('todayAttendance');
    if (attDisp) attDisp.innerText = `${presentCount} / ${students.length}`;

    if (students.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400">প্রথমে শিক্ষার্থী তালিকা থেকে ছাত্র যোগ করুন</td></tr>`;
        return;
    }

    tbody.innerHTML = students.map(s => {
        const status = records[s.id] || 'absent';
        const isPres = status === 'present';
        return `
            <tr class="hover:bg-slate-50 transition">
                <td class="p-3 font-mono text-xs text-indigo-600">রোল #${s.roll}</td>
                <td class="p-3 font-bold text-slate-900">${s.name}</td>
                <td class="p-3 text-slate-600">${s.batch}</td>
                <td class="p-3 text-slate-600">${s.phone}</td>
                <td class="p-3 text-center">
                    <button onclick="window.toggleAttendance('${s.id}', '${date}')" class="px-4 py-1.5 rounded-full text-xs font-bold transition-all shadow-sm ${isPres ? 'bg-emerald-600 text-white' : 'bg-rose-100 text-rose-700'}">
                        ${isPres ? '<i class="fa-solid fa-check mr-1"></i> উপস্থিত' : '<i class="fa-solid fa-xmark mr-1"></i> অনুপস্থিত'}
                    </button>
                </td>
            </tr>
        `;
    }).join('');
};

window.renderFees = function() {
    const tbody = document.getElementById('feeTableBody');
    if (!tbody) return;

    if (students.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">কোনো শিক্ষার্থী পাওয়া যায়নি</td></tr>`;
        return;
    }

    tbody.innerHTML = students.map(s => {
        const paid = Number(feePayments[s.id] || 0);
        const fee = Number(s.fee || 0);
        const due = Math.max(0, fee - paid);
        return `
            <tr class="hover:bg-slate-50 transition">
                <td class="p-3 font-semibold">#${s.roll}</td>
                <td class="p-3 font-bold text-slate-900">${s.name}</td>
                <td class="p-3 text-slate-700">৳ ${fee}</td>
                <td class="p-3 text-emerald-600 font-bold">৳ ${paid}</td>
                <td class="p-3 text-rose-600 font-bold">৳ ${due}</td>
                <td class="p-3 text-center">
                    <button onclick="window.openFeeModal('${s.id}', '${s.name}', ${fee})" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg text-xs font-bold transition">
                        ফি জমা নিন
                    </button>
                </td>
                <td class="p-3 text-right">
                    <span class="text-xs font-semibold px-2.5 py-1 rounded-full ${due === 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">
                        ${due === 0 ? 'পরিশোধিত' : 'বকেয়া'}
                    </span>
                </td>
            </tr>
        `;
    }).join('');
};

window.renderClassroomHub = function() {
    if (document.getElementById('gcClassName')) {
        document.getElementById('gcClassName').value = classroomSettings.className || '';
        document.getElementById('gcClassCode').value = classroomSettings.classCode || '';
        document.getElementById('gcClassLink').value = classroomSettings.classLink || '';
        document.getElementById('gcDriveLink').value = classroomSettings.driveLink || '';
    }

    const listEl = document.getElementById('announcementList');
    if (!listEl) return;

    if (announcements.length === 0) {
        listEl.innerHTML = `<p class="text-xs text-slate-400 text-center py-4">কোনো নোটিশ বা অ্যাসাইনমেন্ট প্রকাশ করা হয়নি</p>`;
        return;
    }

    listEl.innerHTML = announcements.map(a => `
        <div class="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2 relative">
            <button onclick="window.deleteAnnouncement('${a.id}')" class="absolute top-3 right-3 text-slate-400 hover:text-rose-600 text-xs"><i class="fa-solid fa-trash"></i></button>
            <h4 class="font-bold text-slate-800 text-sm">${a.title}</h4>
            <p class="text-xs text-slate-600 leading-relaxed">${a.content}</p>
            ${a.link ? `<a href="${a.link}" target="_blank" class="inline-flex items-center gap-1 text-xs text-indigo-600 font-semibold hover:underline"><i class="fa-solid fa-link"></i> ফাইল/লিংক দেখুন</a>` : ''}
        </div>
    `).join('');
};

window.renderStudentPortal = function() {
    if (!currentStudent) return;

    const nameEl = document.getElementById('studentPortalName');
    const idEl = document.getElementById('stCardUniqueId');
    const rollEl = document.getElementById('stCardRollBatch');

    if (nameEl) nameEl.innerText = currentStudent.name;
    if (idEl) idEl.innerText = currentStudent.uniqueId || currentStudent.id;
    if (rollEl) rollEl.innerText = `#${currentStudent.roll} (${currentStudent.batch})`;

    const fee = Number(currentStudent.fee || 0);
    const paid = Number(feePayments[currentStudent.id] || 0);
    const due = Math.max(0, fee - paid);
    
    const feeStatusEl = document.getElementById('stCardFeeStatus');
    if (feeStatusEl) {
        feeStatusEl.innerText = due === 0 ? 'পরিশোধিত (৳0 বাকি)' : `৳ ${due} বকেয়া`;
    }

    const today = attendanceRecords[todayStr]?.[currentStudent.id];
    const attStatusEl = document.getElementById('stCardTodayAtt');
    if (attStatusEl) {
        attStatusEl.innerText = today === 'present' ? 'উপস্থিত ✅' : 'অনুপস্থিত ❌';
    }

    const gcNameEl = document.getElementById('stGcName');
    const gcCodeEl = document.getElementById('stGcCode');
    if (gcNameEl) gcNameEl.innerText = classroomSettings.className || 'গুগল ক্লাসরুম হাব';
    if (gcCodeEl) gcCodeEl.innerText = classroomSettings.classCode || 'কোড সেট করা হয়নি';
    
    const classBtn = document.getElementById('stGcClassBtn');
    if (classBtn) classBtn.href = classroomSettings.classLink || '#';
    const driveBtn = document.getElementById('stGcDriveBtn');
    if (driveBtn) driveBtn.href = classroomSettings.driveLink || '#';

    const stList = document.getElementById('stAnnouncementList');
    if (stList) {
        if (announcements.length === 0) {
            stList.innerHTML = `<p class="text-xs text-slate-400">শিক্ষকের কোনো নোটিশ নেই</p>`;
        } else {
            stList.innerHTML = announcements.map(a => `
                <div class="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1">
                    <h4 class="font-bold text-slate-800 text-sm">${a.title}</h4>
                    <p class="text-xs text-slate-600">${a.content}</p>
                    ${a.link ? `<a href="${a.link}" target="_blank" class="text-xs text-indigo-600 font-semibold hover:underline block mt-1"><i class="fa-solid fa-link"></i> লিংক ওপেন করুন</a>` : ''}
                </div>
            `).join('');
        }
    }
};

window.renderAdminDashboard = function() {
    let pendingCount = 0;
    let proCount = 0;
    let totalRev = 0;

    paymentRequests.forEach(p => {
        if (p.status === 'pending') pendingCount++;
        if (p.status === 'approved') {
            proCount++;
            totalRev += 199;
        }
    });

    const pendEl = document.getElementById('adminPendingCount');
    const proEl = document.getElementById('adminProCount');
    const revEl = document.getElementById('adminRevenue');

    if (pendEl) pendEl.innerText = `${pendingCount} টি`;
    if (proEl) proEl.innerText = `${proCount} জন`;
    if (revEl) revEl.innerText = `৳ ${totalRev}`;

    const tbody = document.getElementById('adminPaymentsTableBody');
    if (!tbody) return;

    if (paymentRequests.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">কোনো পেমেন্ট রিকোয়েস্ট নেই</td></tr>`;
        return;
    }

    tbody.innerHTML = paymentRequests.map(p => {
        const isPending = p.status === 'pending';
        const isApproved = p.status === 'approved';
        return `
            <tr class="hover:bg-slate-50 transition">
                <td class="p-3 text-xs text-slate-500">${new Date(p.createdAt || Date.now()).toLocaleDateString()}</td>
                <td class="p-3 font-bold text-slate-900">${p.teacherEmail}</td>
                <td class="p-3 font-semibold text-indigo-600">${p.method}</td>
                <td class="p-3 text-slate-700">${p.phone}</td>
                <td class="p-3 font-mono text-xs font-bold text-slate-900">${p.trxId}</td>
                <td class="p-3 text-center">
                    <span class="text-xs font-bold px-2.5 py-1 rounded-full ${isApproved ? 'bg-emerald-100 text-emerald-800' : isPending ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}">
                        ${isApproved ? 'অনুমোদিত (Pro)' : isPending ? 'পেন্ডিং' : 'বাতিল'}
                    </span>
                </td>
                <td class="p-3 text-right space-x-1">
                    ${isPending ? `
                        <button onclick="window.handleVerifyPayment('${p.id}', 'approved')" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1 rounded font-bold shadow">অ্যাপ্রুভ</button>
                        <button onclick="window.handleVerifyPayment('${p.id}', 'rejected')" class="bg-rose-600 hover:bg-rose-700 text-white text-xs px-3 py-1 rounded font-bold shadow">বাতিল</button>
                    ` : `<span class="text-xs text-slate-400">সম্পন্ন</span>`}
                </td>
            </tr>
        `;
    }).join('');
};

// -------------------------------------------------------------
// 12. EXCEL EXPORTING DATA
// -------------------------------------------------------------
window.exportTeacherDataExcel = function() {
    if (students.length === 0) {
        window.showCustomAlert("এক্সপোর্ট করার জন্য কোনো শিক্ষার্থী ডাটা নেই!", "warning");
        return;
    }

    const excelData = students.map((s, idx) => {
        const paid = Number(feePayments[s.id] || 0);
        const fee = Number(s.fee || 0);
        const due = Math.max(0, fee - paid);
        const todayStatus = attendanceRecords[todayStr]?.[s.id] || 'absent';

        return {
            "ক্রমিক": idx + 1,
            "ইউনিক স্টুডেন্ট আইডি": s.uniqueId || '-',
            "রোল নম্বর": s.roll,
            "শিক্ষার্থীর নাম": s.name,
            "শ্রেণী / ব্যাচ": s.batch,
            "অভিভাবক নম্বর": s.phone,
            "মাসিক ফি (টাকা)": fee,
            "পরিশোধিত ফি": paid,
            "বকেয়া ফি": due,
            "আজকের উপস্থিতি": todayStatus === 'present' ? 'উপস্থিত' : 'অনুপস্থিত'
        };
    });

    const worksheet = XLSX.utils.json_to_sheet(excelData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "শিক্ষার্থী তথ্য");
    XLSX.writeFile(workbook, `CoachingDesk_Report_${todayStr}.xlsx`);
    window.showCustomAlert("এক্সেল ফাইল সফলভাবে ডাউনলোড হয়েছে!", "success");
};