// Every string the interface shows, in English. The other languages are typed
// against this one, so a message missing from any of them fails the build.
//
// {name} is filled in by fmt(); <tag>...</tag> marks a link or bold run that
// rich() turns into an element (lib/i18n/format.ts). Long-form pages (About,
// Support) are written per language as their own components instead.

import type { Plural } from "../format";

export const en = {
  meta: {
    siteTitle: "BetterMusicSheet.com | Make your playing easier",
    siteDescription:
      "Upload piano sheet music and get every note labeled with its letter name, " +
      "then play it back with the notes lit up on a keyboard.",
    pageTitle: "{page} | BetterMusicSheet.com",
    about: "About",
    aboutDescription:
      "How BetterMusicSheet reads sheet music, what the annotations mean, and what the recognition can and cannot do.",
    support: "Support",
    supportDescription: "Help with BetterMusicSheet, and how to reach us.",
    privacy: "Privacy",
    privacyDescription: "What BetterMusicSheet collects, why, and how to get rid of it.",
    terms: "Terms",
    termsDescription: "The terms you accept by using BetterMusicSheet.",
    plans: "Go Premium",
    plansDescription:
      "Compare the monthly and yearly BetterMusicSheet Premium plans, with a 7-day free trial for new subscribers.",
  },

  common: {
    loading: "Loading…",
    loadingSheet: "Loading the sheet…",
    loadingSubscription: "Loading subscription…",
    close: "Close",
    cancel: "Cancel",
    delete: "Delete",
    deleting: "Deleting…",
    back: "Back",
    upload: "Upload",
    uploadASheet: "Upload a sheet",
    practiceWithKeyboard: "Practice with the keyboard",
    signIn: "Sign in",
    seePremiumPlans: "See Premium plans",
    untitledSheet: "Untitled sheet",
    thisSheet: "This sheet",
    /** What a sheet with no name is called inside another sentence. */
    sheet: "sheet",
  },

  language: {
    label: "Language",
    /** Shown over the Privacy and Terms pages, which are English only. */
    englishOnly:
      "This page is available in English only. The English text is the version that applies.",
  },

  header: {
    home: "Home",
    library: "Library",
    account: "Account",
    openAccountMenu: "Open account menu",
    openAccountMenuFor: "Open account menu for {email}",
    manageSubscription: "Manage subscription",
    manageSubscriptionTitle: "Manage your subscription",
    signOut: "Sign out",
    signOutTitle: "Sign out of this account",
    deleteAccount: "Delete account",
    deleteAccountTitle: "Permanently delete your account",
    deleteHeading: "Delete your account?",
    deleteBody: "This permanently deletes your account and your sheet history. This can't be undone.",
    deleteBodyEmail: "This permanently deletes your account ({email}) and your sheet history. This can't be undone.",
    /** The word typed to confirm. Compared ignoring case and spaces. */
    confirmWord: "delete",
    typeToConfirm: "Type {word} to confirm",
    typeToEnable: "Type \"{word}\" to enable this button",
    keepAccount: "Keep your account",
    deleteFailed: "Could not delete your account.",
    deleteFailedStatus: "Could not delete your account ({status}).",
  },

  footer: {
    about: "About",
    privacy: "Privacy",
    terms: "Terms",
    support: "Support",
    contact: "Contact",
    disclaimer:
      "Note names are recognised automatically and are not always right — check against your original before you rely on them.",
  },

  landing: {
    title: "Every note on your sheet music, labelled",
    lead:
      "Upload a PDF or a photo of piano music and get the same score back with the letter name printed above " +
      "every note. Then practise with it, played back on an on-screen keyboard with the notes lighting up as they sound.",
    tryHeading: "Or try it first",
    tryBody: "No file to hand? Play a sample sheet right away - no upload, no account.",
    howHeading: "How it works",
    /** Between a step's bold title and the rest of it. */
    stepSeparator: " ",
    steps: [
      { title: "Upload your music.", body: "A PDF works best. A photo of a page works too, if it is flat and evenly lit." },
      {
        title: "It gets read.",
        body:
          "Optical music recognition finds the staves, clefs, key signatures and noteheads, and works out what each " +
          "note is. Pages that come back badly read are automatically read again.",
      },
      {
        title: "You get it back annotated.",
        body: "The same engraving, same layout, with a letter name over each note — and a practice mode that plays it.",
      },
    ],
    getHeading: "What you get",
    /** Between an item's bold title and its description. */
    getSeparator: " — ",
    gets: [
      {
        title: "Note names where you are already looking",
        body: "printed over the noteheads, close enough to read at playing distance without burying the notation.",
      },
      {
        title: "Spelling and size you choose",
        body:
          "sharps or flats, octave numbers if you are still learning where middle C sits, and label size to suit " +
          "how far away the music sits.",
      },
      {
        title: "A practice mode",
        body:
          "the annotated sheet above an 88-key keyboard, playing back with each hand in its own colour and a " +
          "playhead following the music. Click any bar to start there.",
      },
      {
        title: "Your original, untouched",
        body: "the labels are drawn on a copy. You can switch back to the unannotated sheet at any time.",
      },
    ],
    relyHeading: "Before you rely on it",
    relyBody:
      "Optical music recognition is genuinely hard, and this is a reading aid rather than a proofreader. " +
      "Handwritten music is mostly beyond it, and dense passages — fast runs, heavy ornamentation — lose notes " +
      "more often than plain writing does. Check the result against your original. " +
      "<about>What it struggles with, in full</about>.",
    costHeading: "Cost",
    costBody:
      "Trying the sample above is free, with no account needed. Uploading your own sheet music needs an account: " +
      "a free one keeps one sheet at a time and plays its first two lines in practice mode, and Premium removes " +
      "both limits — see <plans>plans</plans>, and the <privacy>privacy policy</privacy> for what is stored.",
  },

  upload: {
    heading: "Upload your sheet music",
    sub: "We read every note on your piano sheet music and pencil in the letter name so you can practice without guessing.",
    accountNote:
      "Uploading needs an account. A free account keeps one sheet at a time; Premium keeps as many as you like - " +
      "<plans>see plans</plans>.",
    dropPrompt: "Drop a PDF or photos here, or click to browse",
    photosOneSheet: "{count} photos · one sheet",
    formats: "PDF, JPG, or PNG · up to {mb} MB",
    photosHint: "Several photos of one score become one sheet, a page each. A digital PDF gives the most accurate labels.",
    addMorePages: "Click or drop to add more pages, then put them in order below.",
    overLimit: "{size} MB · over the {limit} MB limit",
    ready: "{size} KB · ready to annotate",
    removeFile: "Remove this file",
    options: "Options",
    noteNames: "Note names",
    notationLetters: "Letter (C D E)",
    notationNumbers: "簡 Jianpu (1 2 3)",
    notationSolfege: "Solfège (do re mi)",
    labelStyle: "Label style",
    fontSize: "Font size",
    labelColour: "Label colour",
    anyColour: "Choose any colour",
    colours: { black: "Black", blue: "Blue", red: "Red", green: "Green", purple: "Purple" },
    forceDpi: "Force DPI",
    dpiAuto: "Auto (recommended)",
    dpiValue: "{dpi} DPI",
    showOctave: "Show octave number (B♭4)",
    showOctaveShort: "Show octave number",
    autoRetry: "Auto re-read unclear pages",
    autoRetryShort: "Auto re-scan",
    aboutOption: "About {label}",
    help: {
      notation:
        "Letter names each note C, D, E... Jianpu (numbered notation, 簡譜) shows a number instead, and Solfège " +
        "shows a syllable: 1/do = C, 2/re = D, 3/mi = E, 4/fa = F, 5/so = G, 6/la = A, 7/si = B in every key, so a " +
        "number or syllable always means the same piano key - F♯ reads ♯4/♯fa and B♭ reads ♭7/♭si. You can switch " +
        "between all three while viewing the sheet at any time; this sets the printed download.",
      style:
        "Unicode uses musical accidental symbols such as B♭ and C♯. ASCII uses plain-text Bb and C#, which can be " +
        "easier to copy into older software.",
      fontSize:
        "Controls the printed note-label size. Larger labels are easier to read but have less room around dense chords.",
      color:
        "Sets the printed colour of every note label. A colour makes the labels easy to tell apart from the printed " +
        "music, while black keeps the page looking like the original. Pale colours can be hard to read on white paper.",
      dpi:
        "Controls the resolution used for recognition. Auto starts at 300 DPI and can re-read unclear pages using " +
        "different recognition methods. A forced higher value takes longer and uses more memory.",
      octave:
        "Adds the scientific octave number to every label, such as B♭4. This identifies the exact piano key but makes " +
        "each label longer.",
      autoRetry:
        "Automatically re-reads a page when notes are missing or its musical structure looks incomplete. It uses " +
        "higher resolution where noteheads went undetected, and cheaper re-readings where they were found but could " +
        "not be timed. It can improve difficult pages but increases processing time.",
    },
    chooseFirst: "Choose a PDF or photos first",
    beingUploaded: "Your sheet is being uploaded",
    signInToAnnotate: "Sign in to upload and annotate this sheet",
    uploadAndAnnotate: "Upload and annotate this sheet",
    preparingPages: "Preparing pages…",
    uploading: "Uploading…",
    signInToUpload: "Sign in to upload",
    submit: "Upload",
    freeLimitTitle: "One sheet at a time on the free plan",
    freeLimitBody:
      "The free plan keeps one sheet at a time. Delete your current sheet to upload this one, or go Premium to keep " +
      "as many as you like.",
    pagesInOrder: "Pages, in order",
    dragHint: "Drag the pages into order.",
    /** Before and after the number in "Page 3". */
    pageNumberBefore: "Page ",
    pageNumberAfter: "",
    removePage: "Remove page {n}",
    remove: "Remove",
  },

  library: {
    title: "Library",
    sub: "Sheets you've uploaded.",
    status: {
      uploading: "Uploading",
      done: "Annotated",
      failed: "No names",
      processing: "Adding names",
      queued: "Adding names",
    },
    notesLabeled: "{named} notes labeled",
    notesLabeledOf: "{shown}/{total} notes labeled",
    waitToDelete: "Wait for processing to finish before deleting",
    deleteNamed: "Delete {name}",
    pagesNav: "Library pages",
    previousPage: "Previous page",
    nextPage: "Next page",
    pageOf: "Page {page} of {count}",
    deleteTitle: "Delete this sheet?",
    deleteBody: "{name} and its uploaded PDF, annotated PDF, and playback data will be permanently deleted.",
    keepSheet: "Keep this sheet",
    deleteForever: "Permanently delete this sheet and its files",
    deleteFailed: "Could not delete this sheet.",
    deleteFailedStatus: "Could not delete this sheet ({status}).",
  },

  demo: {
    playTitle: "Try practice mode with a sample sheet - free, no account needed",
    sheetTitle: "See the sample sheet, annotated - free, no account needed",
    noSheets: "No sheets annotated yet.",
    showAgain: "Show the sample again",
    title: "Try a sample",
    meta: "Ode to Joy · Beethoven · free, no account needed",
    play: "Play",
    remove: "Remove the sample from your library",
  },

  sheet: {
    noSheet: "No sheet specified.",
    statusFailed: "Couldn't check this sheet's status. Reloading the page usually fixes it.",
    originalNotStored: "The uploaded file isn't stored for this sheet",
    annotationFailed: "Annotation failed",
    tryAnother: "Try another file",
    annotating: "Annotating your sheet…",
    queued: "Queued…",
    namesFailedShort: "Note names couldn't be added to this sheet",
    namesPending: "Note names are still being added",
    namesFailed: "Note names couldn't be added.",
    namesFailedSub: "You can still read, mark up and download the sheet below.",
    retryFailed: "Couldn't start again.",
    retryFailedStatus: "Couldn't start again ({status}).",
    starting: "Starting…",
    tryAgain: "Try again",
    addingNames: "Adding note names…",
    addingNamesSub: "Read and mark up the sheet meanwhile - the names appear here when they're ready.",
    cancelFailed: "Could not cancel this sheet.",
    cancelFailedStatus: "Could not cancel this sheet ({status}).",
    stopTitle: "Stop annotating?",
    stopBody: "{name} will be removed along with its uploaded file, and won't appear in your library.",
    keepGoing: "Keep going",
    cancelling: "Cancelling…",
    stopAndRemove: "Stop and remove",
    dragToResize: "Drag to resize",
    download: {
      customized: "Customized",
      customizedOriginal: "The original with your drawings and notes, as the preview shows it",
      customizedAnnotated: "With your moved and retyped names, drawings and notes",
      annotated: "Annotated",
      annotatedReady: "Note names as generated",
      annotatedPending: "Available once the note names are added",
      original: "Original",
      originalDetail: "The file as you uploaded it",
      failed: "That download didn't finish. Try again.",
      title: "Download this sheet",
      preparing: "Preparing…",
      retry: "Retry download ▾",
      button: "Download ▾",
      customizedFile: "{stem} (customized).pdf",
      annotatedFile: "{stem} (annotated).pdf",
    },
  },

  toggles: {
    sheetVersion: "Sheet version",
    annotated: "Annotated",
    original: "Original",
    showAnnotated: "Show the sheet with note names",
    showOriginal: "Show the sheet as you uploaded it",
    notation: "Note name notation",
    lettersTitle: "Letter names: C D E F G A B",
    numbersTitle: "Jianpu (numbered notation, 簡譜): 1 2 3 4 5 6 7 for C D E F G A B",
    solfegeTitle: "Solfège: do re mi fa so la si for C D E F G A B",
  },

  viewer: {
    tooOld: "This browser is too old to show the sheet.",
    tooOldBody:
      "The viewer needs features your browser does not have yet. Updating it usually fixes this — on an iPhone or " +
      "iPad that means updating iOS or iPadOS itself, since Safari comes with the system. Recent Chrome, Edge and " +
      "Firefox work too.",
    showFailed: "Couldn't show the sheet. Reloading the page usually fixes it.",
    addName: "Add this note's name",
    notRecognized: "This note wasn't recognized, so it has no name",
    plusName: "+ name",
  },

  editor: {
    save: {
      saved: "All changes saved",
      saving: "Saving…",
      offline: "Offline — changes will save when you reconnect",
      error: "Couldn't save yet — retrying",
    },
    previewFailed: "Couldn't show the preview here. The Download button still gives you the file.",
    uploadFailed: "Couldn't show the uploaded file here.",
    loadEditsFailed: "Couldn't load your saved changes. Reload the page to try again.",
    changedElsewhere: "These edits were changed in another window, so that version is shown now.",
    nameHidden: "Name hidden. Undo brings it back.",
    noPlayback: "Playback isn't available for this sheet, so only the page changes.",
    notANoteName: "\"{text}\" isn't a note name, so playback stays the same.",
    notLinked: "This name isn't linked to a note, so only the page changes.",
    restored: "Back to the printed name; playback restored.",
    nowPlays: "Playback now plays {text}.",
    nowPlaysMany: "Playback now plays {text} for {count} notes.",
    resetAll: "Reset to the annotated version: your names, playback fixes, drawings and notes are removed.",
    resetNames: "Note names and playback reset to the annotated version. Your drawings and notes are kept.",
    noteName: "Note name",
    typeANote: "Type a note",
    textNote: "Text note",
    tools: {
      select: "Select",
      selectTitle:
        "Select and move: drag a name or note; Shift- or Ctrl-click, or drag a box over empty space, to select " +
        "several and move them together. Double-click a name to retype it.",
      pen: "Pen",
      penTitle: "Draw on the sheet",
      highlighter: "Highlight",
      highlighterTitle: "Highlight part of the sheet",
      text: "Text",
      textTitle: "Click anywhere to add a text note",
      eraser: "Erase",
      eraserTitle: "Erase drawings and text notes (note names are hidden with Delete instead)",
    },
    zoom: "Zoom",
    zoomOut: "Zoom out",
    zoomOutTitle: "Zoom out (Ctrl + scroll also zooms)",
    zoomIn: "Zoom in",
    zoomInTitle: "Zoom in (Ctrl + scroll also zooms)",
    fitWidth: "Fit the page to the width",
    reset: "Reset",
    resetTitle: "Go back to the annotated version as it was generated",
    resetNamesOnly: "Note names only",
    resetNamesOnlyDetail:
      "Undo moved, retyped and hidden names, and the playback fixes they made. Keeps your drawings and notes.",
    resetEverything: "Everything",
    resetEverythingDetail: "Back to the annotated version exactly as generated.",
    resetEverythingDetailMarks: "Back to the annotated version exactly as generated, removing your drawings and notes too.",
    editSheet: "Edit sheet",
    editSheetTitle: "Move or retype note names, draw, highlight and add notes",
    editSheetTitleNoNames: "Draw, highlight and add notes",
    showingChanges: "Showing your changes",
    namesFixed: "Names on this sheet can't be moved; you can still draw and add notes.",
    editingTools: "Editing tools",
    colour: "Colour",
    colourValue: "Colour {value}",
    highlighterColour: "Highlighter colour",
    highlighterValue: "Highlighter {value}",
    undo: "Undo",
    undoTitle: "Undo (Ctrl+Z)",
    redo: "Redo",
    redoTitle: "Redo (Ctrl+Shift+Z)",
    done: "Done",
    unnamed: {
      one: "{count} printed note wasn't recognized, so it has no name.",
      other: "{count} printed notes weren't recognized, so they have no name.",
    } satisfies Plural,
    unnamedEditing: {
      one: "{count} printed note wasn't recognized, so it has no name. Click a ringed note to add its name.",
      other: "{count} printed notes weren't recognized, so they have no name. Click a ringed note to add its name.",
    } satisfies Plural,
    showNext: "Show next",
    addNames: "Add names",
    selectedName: "Note name {name}",
    linked: " · linked to playback",
    notLinkedShort: " · not linked to playback",
    retype: "Retype",
    selectChord: "Select chord ({count})",
    hide: "Hide",
    edit: "Edit",
    drawing: "Drawing",
    selectedMany: "{count} selected · drag any of them to move them together",
    hideOrDelete: "Hide / delete",
    resetNamesButton: "Reset names",
    clear: "Clear",
    hint:
      "Click to select · Shift- or Ctrl-click, or drag a box, to select several · double-click a name to retype it · " +
      "hold Space and drag to move around",
    hintOriginal: " · note names are edited in the Annotated view",
    dismiss: "Dismiss",
  },

  play: {
    practice: "Practice",
    pickerSub: "Hear a sheet play back, with the notes lit up on a keyboard.",
    noSheets: "No annotated sheets yet. <upload>Upload one first.</upload>",
    practiceNamed: "Practice {name}",
    unavailable: "Playback isn't available for this sheet.",
    openFailed: "Couldn't open this sheet for playback.",
    originalNotStored: "The uploaded file isn't stored for this sheet",
    photoUpload: "This sheet was uploaded as a photo, which Play can't display",
    originalFailed: "The original couldn't be loaded",
    synthFailed: "Could not load the offline synth.",
    instrumentFailed: "Could not load this instrument. Try again or choose Basic synth (offline).",
    instrumentFallback: "Couldn't load {name} (check your connection) — playing with the offline synth instead.",
    selectedInstrument: "the selected instrument",
    pickAnother: "Pick another sheet",
    sheet: "Sheet",
    fallingNotes: "Falling notes",
    collapse: "Collapse {name}",
    expand: "Expand {name}",
    previewUnavailable: "Sheet preview is unavailable, but playback is ready.",
    loadingPreview: "Loading the sheet preview…",
    resizePanels: "Resize the sheet and the falling notes",
    position: "Position in the piece",
    measure: "Measure {label} · {index} / {count}",
    cancelLoading: "Cancel loading playback",
    pause: "Pause",
    play: "Play",
    previousNote: "Previous note",
    previousNoteLabel: "Step to the previous note",
    nextNote: "Next note",
    nextNoteLabel: "Step to the next note",
    hideOptions: "Hide options",
    moreOptions: "More options",
    speed: "Speed",
    speedCapped: "Capped from {speed}x by the BPM limit",
    showKeyNames: "Show key names",
    hideKeyNames: "Hide key names",
    showNoteNames: "Show names on falling notes",
    hideNoteNames: "Hide names on falling notes",
    mute: "Mute",
    unmute: "Unmute",
    bpm: "BPM",
    baseTempo: "Base tempo in {unit}s per minute",
    /** For a unit with no name of its own, already plural. */
    baseTempoPlain: "Base tempo in {unit} per minute",
    tempoFromScore: "Detected from the score ({unit} beats) - change it to override",
    tempoDefault: "No tempo marking was found on the sheet; this is a default",
    /** The score's beat unit, keyed by its length in quarter notes (tempo.ts). */
    units: {
      "0.25": "sixteenth note",
      "0.5": "eighth note",
      "0.75": "dotted eighth note",
      "1": "quarter note",
      "1.5": "dotted quarter note",
      "2": "half note",
      "3": "dotted half note",
      "4": "whole note",
      "6": "dotted whole note",
    } as Record<string, string>,
    unitQuarters: "{count} quarter notes",
    instrument: "Instrument",
    instruments: {
      grand: "Grand piano",
      electric: "Electric piano · Wurlitzer",
      cp80: "Electric grand · CP80",
      organ: "Church organ",
      basic: "Basic synth (offline)",
    },
    loadingInstrument: "Loading instrument",
    approximatePosition: "Approximate note position",
    matchedPosition: "Matched note position",
    gateFailed: "Practice needs note names, and they couldn't be added to this sheet.",
    gateRetry: "You can try again from the sheet itself.",
    gateReadBelow: "You can still read it below.",
    gateWaiting: "Getting practice ready…",
    gateWaitingSub: "Playback starts here by itself once the note names are added.",
    openSheet: "Open the sheet",
  },

  signIn: {
    titles: {
      signin: "Sign in",
      signup: "Create an account",
      confirm: "Check your email",
      forgot: "Reset your password",
      reset: "Choose a new password",
    },
    social: {
      Google: "Sign in with Google",
      SignInWithApple: "Sign in with Apple",
      Facebook: "Sign in with Facebook",
    },
    or: "or",
    errors: {
      incorrect: "Incorrect email or password.",
      exists: "An account with that email already exists.",
      codeMismatch: "That code doesn't match. Check it and try again.",
      codeExpired: "That code has expired - request a new one.",
      tooMany: "Too many attempts. Wait a few minutes and try again.",
      badPassword: "That password doesn't meet the requirements below.",
      notConfirmed: "This account still needs the emailed confirmation code.",
      nameRequired: "Please enter a display name.",
      network: "Couldn't reach the sign-in service. Check your connection and try again.",
    },
    notConfirmedResent: "Your account isn't confirmed yet - we've sent you a new code.",
    codeSent: "We've emailed you a confirmation code.",
    resetSent:
      "If {email} has a password account, a reset code is on its way - check spam too. Signed up with Google or " +
      "Apple? There's no password to reset; use that button on the sign-in screen.",
    resent: "Sent - check your email again.",
    submit: {
      signin: "Sign in",
      signinBusy: "Signing in…",
      signup: "Create account",
      signupBusy: "Creating…",
      confirm: "Confirm",
      confirmBusy: "Confirming…",
      forgot: "Send reset code",
      forgotBusy: "Sending…",
      reset: "Save and sign in",
      resetBusy: "Saving…",
    },
    enterCode: "Enter the code we sent to {email}.",
    forgotIntro:
      "We'll email you a code to set a new password. If you signed in with Google or Apple, go back and use that " +
      "button instead - those accounts don't have a password.",
    email: "Email",
    displayName: "Display name",
    code: "Code",
    password: "Password",
    newPassword: "New password",
    passwordHint: "At least 8 characters, with a number, an uppercase and a lowercase letter.",
    forgotLink: "Forgot password?",
    forgotLinkTitle: "Reset a forgotten password",
    createLink: "Create an account",
    createLinkTitle: "Register a new account",
    backToSignIn: "Back to sign in",
    backToSignInTitle: "Return to the sign-in form",
    resend: "Resend code",
    resendTitle: "Send another confirmation code",
  },

  paywall: {
    benefits: [
      "Keep as many sheets as you like",
      "Every note labelled",
      "Full practice mode, every line",
      "Practise on a keyboard",
      "Access anywhere",
    ],
    free: "Free",
    freePlan: "Free plan",
    freeSub: "Your plan without Premium.",
    freePoints: {
      labelled: "Every note labelled",
      edit: "Edit, retype and download your sheet",
      oneSheet: "One sheet at a time",
      twoLines: "First two lines in practice mode",
    },
    termsTitle: "Before you start",
    trialStarts: "Your 7-day free trial starts today, then it's {price}.",
    chargedNow: "Your subscription starts today, and you'll be charged {price} right away.",
    cancelTermsTrial:
      "Cancel during the trial and you won't be charged. After that, cancelling stops the next renewal: you keep " +
      "access until the end of the {period} you've paid for, and payments already made aren't refunded.",
    cancelTerms:
      "Cancelling stops the next renewal: you keep access until the end of the {period} you've paid for, and " +
      "payments already made aren't refunded.",
    month: "month",
    year: "year",
    priceMonthly: "$1.99/month",
    /** The price on a plan card, before "/ month". US dollars in every language. */
    amountMonthly: "$1.99",
    amountYearly: "$19.99",
    priceYearly: "$19.99/year",
    openingCheckout: "Opening checkout…",
    agree: "Agree",
    checkoutFailed: "Could not start checkout.",
    kicker: "Premium",
    heroTitle: "Your own sheet music, labelled",
    heroBody:
      "Upload your piano music and get it back with the letter name above every note, then practise it on a " +
      "keyboard that lights up each note as it plays.",
    chooseBilling: "Choose a billing period",
    monthly: "Monthly",
    yearly: "Yearly",
    save: "Save 20%",
    perMonth: "/ month",
    perYear: "/ year",
    monthlyBody: "Flexible access, billed monthly.",
    yearlyBody: "Best value for a full year of practice.",
    signInToSubscribe: "Sign in to subscribe.",
    startTrial: "Start 7-day free trial",
    subscribe: "Subscribe",
    choosePlanTrial: "Choose monthly or yearly to start your 7-day free trial.",
    choosePlan: "Choose monthly or yearly to subscribe.",
    trialNote: "7-day free trial for new subscribers. Cancel anytime. Then {price}.",
    billedNote: "Billed {price} from today. Cancel anytime.",
    premiumPlans: "Premium plans",
    goPremium: "Go Premium",
    keepPracticing: "Keep practicing",
    previewOver: "That's the free preview: the first two lines. Subscribe for full practice mode on every piece.",
    previewOverTrial:
      "That's the free preview: the first two lines. Subscribe for full practice mode on every piece, with a " +
      "7-day free trial.",
  },

  subscription: {
    title: "Your subscription",
    signInToManage: "Sign in to view or manage a subscription.",
    plan: "Plan",
    status: "Status",
    masterAccount: "Master account",
    masterStatus: "Full access, no subscription needed",
    cancelsAtEnd: "Cancels at period end",
    trialActive: "Trial active",
    active: "Active",
    started: "Started",
    accessEnds: "Access ends",
    renews: "Renews",
    pending:
      "Cancellation is pending. Premium access continues until {date}, then ends. You won't be charged again, and " +
      "no refund is issued for the current period.",
    openApple: "Open Apple subscriptions",
    cancelTrialConfirm: "Cancel your free trial? You keep Premium access until {date}, and you won't be charged.",
    cancelConfirm:
      "Cancel your subscription? It stays active until the end of the period you've paid for, {date}, and then " +
      "ends. You won't be charged again, but no refund is issued for the time remaining.",
    confirmCancel: "Confirm cancellation",
    keep: "Keep subscription",
    cancelButton: "Cancel Subscription",
    cancelFailed: "Could not cancel the subscription.",
    cancelledTitle: "Checkout cancelled — no charge",
    cancelledBody: "You can subscribe whenever you're ready.",
    seePlans: "See plans",
    plansBody: "Unlock full practice mode and keep as many sheets as you like, on all your devices.",
    plansMonthly: "Billed monthly. 7-day free trial for new subscribers.",
    plansYearly: "Billed yearly. 7-day free trial for new subscribers.",
    getStarted: "Get Started",
    whatYouGet: "What you get",
    plansPoints: [
      "Full practice mode — every note lit up as you play",
      "Keep as many sheets as you like",
      "Access on any device, synced to your account",
      "Cancel anytime, no long-term commitment",
    ],
    plansFree: "On the free plan you keep one sheet at a time, and practice mode plays its first two lines.",
    confirming: "Confirming your subscription…",
    almostThere: "Almost there",
    trialStarted: "Your trial has started",
    subscribed: "You're subscribed",
    moment: "This only takes a moment.",
    waitingStripe: "We're still waiting to hear back from Stripe. This updates as soon as it does.",
    readyBody: "Upload your sheet music and start practising whenever you're ready.",
    checkStatus: "Check subscription status",
    startPractising: "Start practising",
  },

  /** Messages that come from the server or lib code in English, shown in the
   * page's language when they're recognised (lib/i18n/known-text.ts). */
  known: {
    stages: {
      uploading: "Uploading sheet",
      waiting: "Waiting for a recognition worker",
      reading: "Reading sheet music",
      rereading: "Re-reading unclear pages",
      matching: "Matching pitches to notes",
      timeline: "Building playback timeline",
      drawing: "Drawing the annotated sheet",
      complete: "Complete",
      failed: "Processing failed",
      recovering: "Recovering interrupted processing",
      retrying: "Retrying interrupted processing",
      /** Follows a stage name with no space between, so a translation
       * that wants one starts with it. */
      page: "(page {page} of {pages})",
      lessThanMinute: "less than a minute",
      aboutMinute: "about a minute",
      aboutMinutes: "about {count} minutes",
      minutesRange: "{low}-{high} minutes",
      notesToRead: "{count} notes to read",
      patience: "thanks for your patience",
      rereadScan: "re-reading the scan should take {time}",
      rereadPages: "re-reading them should take {time}",
      timelineBuilt: "{measures} measures, {notes} notes",
    },
    errors: {
      unreadable:
        "We couldn't read the music on this sheet. We've been notified and will look into it - you can try again later.",
      tooLong: "This sheet took too long to read. Uploading fewer pages at a time usually helps.",
      notStarted: "We couldn't start reading this sheet. Please try again in a few minutes.",
      invalidSheet: "Upload a valid, unencrypted PDF or image with at most {pages} pages.",
      sizeMismatch: "Uploaded file size does not match the selected file.",
      prepareFailed: "Could not prepare upload.",
      uploadFailed: "Upload failed.",
      notMusic:
        "No music notation was detected in this PDF. Make sure it's actually a sheet music score (with staff lines " +
        "and notes) and not a scan of something else, a blank page, or a non-music document.",
      freeLimit:
        "The free plan keeps 1 sheet at a time. Delete your current sheet to upload another, or go Premium for " +
        "unlimited sheets.",
      retryNoUpload: "This upload didn't finish, so there is nothing to read again. Please upload the file again.",
      unsupportedType: "Only PDF, JPG and PNG files are supported.",
      alreadyProcessing: "You already have a sheet processing. Wait for it to finish.",
      signInToUpload: "Sign in to upload a sheet.",
      fileTooLarge: "File must be at most {mb} MB.",
      invalidOptions: "Invalid file or annotation options.",
      notReady: "The sheet is not ready yet.",
      waitToDelete: "Wait for this sheet to finish processing before deleting it.",
      waitForUpload: "Wait for your current upload to finish before deleting your account.",
      changed: "This sheet changed; refresh and try again.",
      demoDelete: "The demo sheet can't be deleted.",
      notWaiting: "This sheet isn't waiting to be tried again.",
      tooManyDrawings: "Too many drawings on this sheet to save. Erase some and try again.",
      refresh: "Please refresh the page to use the updated upload form.",
      noSubscription: "No active subscription found.",
      otherStore: "This subscription is billed through a different store. Reload and try again.",
      appleManaged:
        "This subscription was bought through Apple, so it's cancelled in your Apple ID settings. Open " +
        "Subscriptions there and choose Cancel Subscription.",
      // Raised in the browser (lib/photo-pages.ts, lib/sheet-files.ts).
      pdfAndPhotos:
        "A PDF and photos can't be uploaded together. Upload the PDF on its own, or remove it and upload only photos.",
      onePdf: "Upload one PDF at a time.",
      maxPages: "A sheet can have at most {count} pages.",
      couldntRead: "Couldn't read {name}.",
      couldntReadPhoto: "Couldn't read the photo.",
      photosTooLarge:
        "These {count} photos come to {size} MB together, over the {limit} MB limit. Try fewer pages per upload.",
      thisFileTooLarge: "This file is {size} MB. Files must be at most {limit} MB.",
      s3Failed: "The file upload failed. Please try again. An unfinished upload expires after 15 minutes.",
    },
  },
};

export type Messages = typeof en;
