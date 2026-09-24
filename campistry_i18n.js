/* =============================================================================
 * campistry_i18n.js — real text translation, camp-wide.
 *
 * WHAT EXISTED BEFORE THIS: a Language dropdown (Dashboard -> Camp Settings)
 * that only ever affected date formatting (toLocaleDateString), an optional
 * Hebrew-calendar overlay, alt-name display, and a manual RTL checkbox. No
 * English text was ever translated — picking "Spanish" changed how dates
 * looked, nothing else.
 *
 * WHAT THIS FILE ADDS: an actual translation layer. A page opts in by
 * loading this script and marking translatable text with `data-i18n="key"`
 * (text content) or `data-i18n-ph="key"` (placeholder attribute), then
 * calling `CampistryI18n.applyDom()` once the camp's locale is known.
 * RTL is now DERIVED from the language, not a separate setting — see
 * RTL_LANGS below — so it can never disagree with what was actually picked.
 *
 * SCOPE, STATED HONESTLY: this ships with real dictionaries for the shared
 * app chrome (nav/buttons/common words) and the parent Registration form
 * (campistry_register.html) — the two places a non-English-speaking PARENT
 * (not staff) actually needs this, and the highest-value place to start.
 * Extending coverage to another page is: add `data-i18n` attributes to that
 * page's markup, add the matching keys to DICTS below for each language,
 * call `CampistryI18n.applyDom()` after the camp's locale loads. No other
 * page's behavior changes by this file merely being loaded — an untagged
 * page in an untranslated language just keeps showing its English text,
 * same as before.
 *
 * Fallback rule: a missing key in any non-English language falls back to
 * the English string rather than showing a raw key or blank text — a half-
 * translated page is still usable, a page full of "nav.dashboard" is not.
 * ========================================================================== */
(function (root) {
    'use strict';
    var I = {};

    I.LANGS = {
        'en-US': 'English',
        'he-IL': 'עברית',
        'yi':    'ייִדיש',
        'ru-RU': 'Русский',
        'es-ES': 'Español'
    };

    // Hebrew, Yiddish (and Arabic, if it's ever added to the picker) read
    // right-to-left. This is the single source of truth for that fact —
    // nothing else decides it, so there's no separate toggle to disagree
    // with the language you actually picked.
    I.RTL_LANGS = { 'he-IL': 1, 'yi': 1, 'ar-SA': 1 };
    I.isRTL = function (locale) { return !!I.RTL_LANGS[locale]; };

    /** Flips <html dir> and lang to match the locale. Call this once the
     *  camp's locale is known, on every page that loads this file. */
    I.applyDir = function (locale) {
        var dir = I.isRTL(locale) ? 'rtl' : 'ltr';
        try {
            document.documentElement.setAttribute('dir', dir);
            document.documentElement.setAttribute('lang', locale || 'en-US');
        } catch (e) {}
    };

    // ── Dictionaries ─────────────────────────────────────────────────────
    // en-US is the source of truth for KEYS (every other language's missing
    // key falls back to this one). Add a key here first, then translate it
    // into whichever of the four other languages you're extending.
    var DICTS = {
        'en-US': {
            // Shared chrome
            'nav.dashboard': 'Dashboard', 'nav.help': 'Help', 'nav.signOut': 'Sign Out',
            'common.save': 'Save', 'common.cancel': 'Cancel', 'common.edit': 'Edit',
            'common.delete': 'Delete', 'common.close': 'Close', 'common.submit': 'Submit',
            'common.back': 'Back', 'common.next': 'Next', 'common.loading': 'Loading…',
            'common.required': 'Required', 'common.optional': 'Optional',
            // Registration form
            'reg.title': 'Camp Registration',
            'reg.campersTab': 'Campers', 'reg.paymentTab': 'Payment', 'reg.reviewTab': 'Review',
            'reg.camperFirstName': 'First Name', 'reg.camperLastName': 'Last Name',
            'reg.camperDob': 'Date of Birth', 'reg.camperGrade': 'Grade',
            'reg.parentName': 'Parent/Guardian Name', 'reg.parentEmail': 'Email',
            'reg.parentPhone': 'Phone', 'reg.address': 'Address',
            'reg.session': 'Session', 'reg.addCamper': 'Add Another Camper',
            'reg.removeCamper': 'Remove', 'reg.emergencyContact': 'Emergency Contact',
            'reg.medicalInfo': 'Medical Information', 'reg.allergies': 'Allergies',
            'reg.medications': 'Medications', 'reg.paymentMethod': 'Payment Method',
            'reg.total': 'Total', 'reg.submitApplication': 'Submit Application',
            'reg.reviewYourInfo': 'Review Your Information', 'reg.thankYou': 'Thank You!',
            'reg.appReceived': 'Your application has been received.'
        },
        'he-IL': {
            'nav.dashboard': 'לוח בקרה', 'nav.help': 'עזרה', 'nav.signOut': 'התנתקות',
            'common.save': 'שמור', 'common.cancel': 'ביטול', 'common.edit': 'עריכה',
            'common.delete': 'מחיקה', 'common.close': 'סגור', 'common.submit': 'שלח',
            'common.back': 'חזרה', 'common.next': 'הבא', 'common.loading': 'טוען…',
            'common.required': 'שדה חובה', 'common.optional': 'לא חובה',
            'reg.title': 'הרשמה למחנה',
            'reg.campersTab': 'חניכים', 'reg.paymentTab': 'תשלום', 'reg.reviewTab': 'סקירה',
            'reg.camperFirstName': 'שם פרטי', 'reg.camperLastName': 'שם משפחה',
            'reg.camperDob': 'תאריך לידה', 'reg.camperGrade': 'כיתה',
            'reg.parentName': 'שם ההורה/אפוטרופוס', 'reg.parentEmail': 'דוא"ל',
            'reg.parentPhone': 'טלפון', 'reg.address': 'כתובת',
            'reg.session': 'מושב', 'reg.addCamper': 'הוסף חניך נוסף',
            'reg.removeCamper': 'הסר', 'reg.emergencyContact': 'איש קשר לחירום',
            'reg.medicalInfo': 'מידע רפואי', 'reg.allergies': 'אלרגיות',
            'reg.medications': 'תרופות', 'reg.paymentMethod': 'אמצעי תשלום',
            'reg.total': 'סה"כ', 'reg.submitApplication': 'שלח בקשה',
            'reg.reviewYourInfo': 'בדוק את הפרטים שלך', 'reg.thankYou': 'תודה!',
            'reg.appReceived': 'הבקשה שלך התקבלה.'
        },
        'yi': {
            'nav.dashboard': 'דאשבארד', 'nav.help': 'הילף', 'nav.signOut': 'אַרויסלאָגירן',
            'common.save': 'היט אָפּ', 'common.cancel': 'אַנולירן', 'common.edit': 'רעדאַגירן',
            'common.delete': 'לעשן', 'common.close': 'פֿאַרמאַכן', 'common.submit': 'שיקן',
            'common.back': 'צוריק', 'common.next': 'ווייטער', 'common.loading': 'לאָדנדיק…',
            'common.required': 'פֿאַרלאַנגט', 'common.optional': 'רשות',
            'reg.title': 'קעמפּ רעגיסטראַציע',
            'reg.campersTab': 'קעמפּערס', 'reg.paymentTab': 'צאָלונג', 'reg.reviewTab': 'איבערבליק',
            'reg.camperFirstName': 'פֿאָרנאָמען', 'reg.camperLastName': 'פֿאַמיליע נאָמען',
            'reg.camperDob': 'געבוירן טאָג', 'reg.camperGrade': 'קלאַס',
            'reg.parentName': 'עלטערן נאָמען', 'reg.parentEmail': 'בליצפּאָסט',
            'reg.parentPhone': 'טעלעפֿאָן', 'reg.address': 'אַדרעס',
            'reg.session': 'סעסיע', 'reg.addCamper': 'צוגעבן נאָך אַ קעמפּער',
            'reg.removeCamper': 'אַראָפּנעמען', 'reg.emergencyContact': 'נויטפאַל קאָנטאַקט',
            'reg.medicalInfo': 'מעדיצינישע אינפֿאָרמאַציע', 'reg.allergies': 'אַלערגיעס',
            'reg.medications': 'רפואות', 'reg.paymentMethod': 'צאָלונג אופֿן',
            'reg.total': 'טאָטאַל', 'reg.submitApplication': 'שיקן אַפּליקאַציע',
            'reg.reviewYourInfo': 'קוקט איבער אייער אינפֿאָרמאַציע', 'reg.thankYou': 'אַ דאַנק!',
            'reg.appReceived': 'אייער אַפּליקאַציע איז אָנגעקומען.'
        },
        'ru-RU': {
            'nav.dashboard': 'Панель управления', 'nav.help': 'Помощь', 'nav.signOut': 'Выйти',
            'common.save': 'Сохранить', 'common.cancel': 'Отмена', 'common.edit': 'Изменить',
            'common.delete': 'Удалить', 'common.close': 'Закрыть', 'common.submit': 'Отправить',
            'common.back': 'Назад', 'common.next': 'Далее', 'common.loading': 'Загрузка…',
            'common.required': 'Обязательно', 'common.optional': 'Необязательно',
            'reg.title': 'Регистрация в лагерь',
            'reg.campersTab': 'Дети', 'reg.paymentTab': 'Оплата', 'reg.reviewTab': 'Проверка',
            'reg.camperFirstName': 'Имя', 'reg.camperLastName': 'Фамилия',
            'reg.camperDob': 'Дата рождения', 'reg.camperGrade': 'Класс',
            'reg.parentName': 'Имя родителя/опекуна', 'reg.parentEmail': 'Эл. почта',
            'reg.parentPhone': 'Телефон', 'reg.address': 'Адрес',
            'reg.session': 'Смена', 'reg.addCamper': 'Добавить ещё ребёнка',
            'reg.removeCamper': 'Удалить', 'reg.emergencyContact': 'Экстренный контакт',
            'reg.medicalInfo': 'Медицинская информация', 'reg.allergies': 'Аллергии',
            'reg.medications': 'Лекарства', 'reg.paymentMethod': 'Способ оплаты',
            'reg.total': 'Итого', 'reg.submitApplication': 'Отправить заявку',
            'reg.reviewYourInfo': 'Проверьте свои данные', 'reg.thankYou': 'Спасибо!',
            'reg.appReceived': 'Ваша заявка получена.'
        },
        'es-ES': {
            'nav.dashboard': 'Panel', 'nav.help': 'Ayuda', 'nav.signOut': 'Cerrar sesión',
            'common.save': 'Guardar', 'common.cancel': 'Cancelar', 'common.edit': 'Editar',
            'common.delete': 'Eliminar', 'common.close': 'Cerrar', 'common.submit': 'Enviar',
            'common.back': 'Atrás', 'common.next': 'Siguiente', 'common.loading': 'Cargando…',
            'common.required': 'Obligatorio', 'common.optional': 'Opcional',
            'reg.title': 'Inscripción al campamento',
            'reg.campersTab': 'Campistas', 'reg.paymentTab': 'Pago', 'reg.reviewTab': 'Revisión',
            'reg.camperFirstName': 'Nombre', 'reg.camperLastName': 'Apellido',
            'reg.camperDob': 'Fecha de nacimiento', 'reg.camperGrade': 'Grado',
            'reg.parentName': 'Nombre del padre/tutor', 'reg.parentEmail': 'Correo electrónico',
            'reg.parentPhone': 'Teléfono', 'reg.address': 'Dirección',
            'reg.session': 'Sesión', 'reg.addCamper': 'Agregar otro campista',
            'reg.removeCamper': 'Quitar', 'reg.emergencyContact': 'Contacto de emergencia',
            'reg.medicalInfo': 'Información médica', 'reg.allergies': 'Alergias',
            'reg.medications': 'Medicamentos', 'reg.paymentMethod': 'Método de pago',
            'reg.total': 'Total', 'reg.submitApplication': 'Enviar solicitud',
            'reg.reviewYourInfo': 'Revisa tu información', 'reg.thankYou': '¡Gracias!',
            'reg.appReceived': 'Tu solicitud ha sido recibida.'
        }
    };

    var _locale = 'en-US';
    I.setLocale = function (locale) { _locale = DICTS[locale] ? locale : 'en-US'; };
    I.getLocale = function () { return _locale; };

    /** key -> translated string, falling back to English, falling back to
     *  the key itself only if English is somehow missing it too (a coding
     *  error, not a translation gap). */
    I.t = function (key, locale) {
        var loc = locale || _locale;
        var d = DICTS[loc] || DICTS['en-US'];
        if (d && d[key] != null) return d[key];
        var en = DICTS['en-US'];
        return (en && en[key] != null) ? en[key] : key;
    };

    /** Walks the DOM (or a subtree) applying every data-i18n / data-i18n-ph
     *  element to the current locale. Safe to call repeatedly (e.g. after
     *  re-rendering a section) — it only ever sets text/placeholder, never
     *  restructures anything. */
    I.applyDom = function (root2) {
        var scope = root2 || document;
        var nodes = scope.querySelectorAll('[data-i18n]');
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].textContent = I.t(nodes[i].getAttribute('data-i18n'));
        }
        var ph = scope.querySelectorAll('[data-i18n-ph]');
        for (var j = 0; j < ph.length; j++) {
            ph[j].setAttribute('placeholder', I.t(ph[j].getAttribute('data-i18n-ph')));
        }
    };

    /** The one call a page needs: given the camp's saved locale, sets
     *  dir/lang on <html>, sets the active dictionary, and translates
     *  everything already tagged in the DOM. */
    I.applyCampLocale = function (locale) {
        I.setLocale(locale || 'en-US');
        I.applyDir(_locale);
        I.applyDom();
    };

    if (typeof root !== 'undefined' && root) root.CampistryI18n = I;
    if (typeof module !== 'undefined' && module.exports) module.exports = I;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
