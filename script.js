// Import prompts from the separate file
import {geemsPrompts} from './prompts.js';

// --- Game State Variables ---
let historyQueue = [];
const MAX_HISTORY_SIZE = 20; // Updated history size
let currentUiJson = null;
let currentNotes = {}; // Holds the full Markdown notes string
let currentSubjectId = "";
let isMasturbationMode = false; // Default mode
let isLoading = false;
let apiKeyLocked = false;
let localGameState = null; // Added to store the user's own saved state

// --- Multiplayer State Variables ---
const HOST_UUID = 'geems-alpha-host-7b3d9e1a'; // Hardcoded UUID for default channel
let peer = null; // PeerJS instance
let localPeerId = null;
let hostPeerId = null; // Track the ID of the current host
let connections = new Map(); // Map<peerId, DataConnection>

// --- Model Switching State ---
const AVAILABLE_MODELS = ["gemini-2.5-pro-exp-03-25",
    "gemini-2.0-pro-exp-02-05",
    "gemini-1.5-pro",
    "gemini-2.0-flash-exp",
    "gemini-exp-1206"];
let currentModelIndex = 0;

// --- Temporary storage ---
let pendingPlayerAnalysis = null;
let pendingGeminiAnalysis = null;
let pendingTweetData = null;

// --- Configuration ---
const MIN_CONTRAST_LIGHTNESS = 0.55;
const LOCAL_STORAGE_KEY = 'geemsGameStateToRestore';

// --- DOM Element References ---
const uiContainer = document.getElementById('ui-elements');
const loadingIndicator = document.getElementById('loading');
const submitButton = document.getElementById('submit-turn');
const apiKeyInput = document.getElementById('apiKeyInput');
const apiKeySection = document.getElementById('apiKeySection');
const errorDisplay = document.getElementById('error-display');
const saveGameButton = document.getElementById('saveGameButton');
const modeToggleButton = document.getElementById('modeToggleButton');
const resetGameButton = document.getElementById('resetGameButton'); // Added Reset Button Ref
const clipboardMessage = document.getElementById('clipboardMessage');
const headerBanner = document.getElementById('headerBanner');
const footerBanner = document.getElementById('footerBanner');
const footerIconImage = document.getElementById('footerIconImage'); // Check if this ID exists in HTML
const playerIconsContainer = document.getElementById('player-icons-container'); // Added Player Icons Container Ref

// --- Web Audio API Context ---
let audioCtx = null; // Initialize AudioContext lazily

// --- Helper Functions ---

/** Encodes a string using Base64. */
function encodeApiKey(key) {
    try {
        return btoa(key);
    } catch (e) {
        console.error("Error encoding API key:", e);
        return ""; // Return empty string on error
    }
}

/** Decodes a Base64 string. Returns null on error. */
function decodeApiKey(encodedKey) {
    try {
        return atob(encodedKey);
    } catch (e) {
        console.error("Error decoding API key:", e);
        return null; // Return null on error
    }
}

/**
 * Constructs the full prompt for the Gemini API call based on the turn number.
 * @param {string} playerActionsJson - JSON string of player actions from the turn just completed.
 * @param {Array<object>} historyQueue - Array containing history data (UI and actions).
 * @param {boolean} isMasturbationMode - Flag indicating if Masturbation Mode is active.
 * @returns {string} The fully constructed prompt text.
 */
function constructPrompt(playerActionsJson, historyQueue, isMasturbationMode) {
    // --- Common Elements ---
    const baseMainPrompt = geemsPrompts.main;
    // Add the Masturbation Mode addendum if the mode is active
    const activeAddendum = isMasturbationMode ? `\n\n---\n${geemsPrompts.masturbationModeAddendum}\n---\n` : "";

    // --- Turn-Specific Logic ---
    if (historyQueue.length === 0) {
        // For the VERY FIRST turn:
        // Include firstRun instructions, main prompt (with potential addendum), and the example turn.
        // No history or player actions are sent.
        const s = `${geemsPrompts.firstrun}\n\n---\n${baseMainPrompt}${activeAddendum}\n---\n${geemsPrompts.exampleTurn}\n---\n\n--- Generate JSON UI for Turn 1 ---`;
        console.log("Generated T1 Prompt Snippet:", s.substring(0, 200) + "...");
        return s;

    } else {
        // For SUBSEQUENT turns (Turn 2+):
        // Include main prompt (with potential addendum), the last player actions, and the recent history.
        // Do NOT include firstRun or exampleTurn.
        const historyString = historyQueue.map(item => `UI:\n${item.ui}\nActions:\n${item.actions}`).join('\n---\n');
        const s = `${baseMainPrompt}${activeAddendum}\n\n--- Last Player Actions ---\n${playerActionsJson}\n\n--- Prior Game History (Last ${historyQueue.length} turns) ---\n${historyString}\n\n--- Generate Next Game Turn JSON UI ARRAY ---`;
        console.log("Generated Subsequent Turn Prompt Snippet:", s.substring(0, 200) + "...");
        return s;
    }
}


/**
 * Saves the current essential game state to local storage.
 * This allows the game to be resumed later.
 */
function autoSaveGameState() {
    if (!apiKeyLocked) {
        console.log("Auto-save skipped: API key not locked (game likely not started).");
        return;
    }
    if (!currentUiJson || !historyQueue) {
        console.warn("Auto-save skipped: Missing current UI or history data.");
        return;
    }

    const rawApiKey = apiKeyInput.value.trim();
    if (!rawApiKey) {
        console.error("Auto-save failed: API Key is missing.");
        // Optionally show a non-intrusive message to the user if this happens repeatedly
        return;
    }

    try {
        const stateToSave = {
            // Only save essential data needed for restore
            encodedApiKey: encodeApiKey(rawApiKey),
            currentUiJson: currentUiJson,
            historyQueue: historyQueue,
            isMasturbationMode: isMasturbationMode,
            currentModelIndex: currentModelIndex
            // DO NOT include gameUrl here for auto-save
        };

        const stateJsonString = JSON.stringify(stateToSave);
        localStorage.setItem(LOCAL_STORAGE_KEY, stateJsonString);
        console.log("Game state auto-saved to localStorage.");

    } catch (error) {
        console.error("Error during auto-save:", error);
        // Consider removing the potentially corrupted item
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        showError("Error auto-saving game state. Progress might be lost.");
    }
}

/**
 * Captures the current game state for local restoration or sending to peers.
 * @returns {object|null} The game state object or null if state is invalid.
 */
function captureGameState() {
    if (!currentUiJson || !historyQueue || !currentNotes || currentSubjectId === undefined) {
        console.warn("Cannot capture game state: Essential data missing.");
        return null;
    }
    return {
        currentUiJson: currentUiJson,
        historyQueue: historyQueue,
        currentNotes: currentNotes, // Include the notes string
        currentSubjectId: currentSubjectId,
        isMasturbationMode: isMasturbationMode // Include mode as it affects interpretation
        // Note: API key and model index are not part of the shareable/restorable state
    };
}

/**
 * Loads a previously captured game state into the current game.
 * @param {object} stateObject - The game state object to load.
 */
function loadGameState(stateObject) {
    if (!stateObject || !stateObject.currentUiJson || !stateObject.historyQueue || !stateObject.currentNotes || stateObject.currentSubjectId === undefined) {
        console.error("Invalid game state object provided to loadGameState:", stateObject);
        showError("Failed to load received game state (invalid data).");
        return;
    }

    try {
        console.log("Loading game state:", stateObject);
        // Restore state variables
        currentUiJson = stateObject.currentUiJson;
        historyQueue = stateObject.historyQueue;
        currentNotes = stateObject.currentNotes;
        currentSubjectId = stateObject.currentSubjectId;
        isMasturbationMode = stateObject.isMasturbationMode; // Restore mode

        // Re-render the UI based on the loaded state
        renderUI(currentUiJson);

        // Update other UI elements if necessary (e.g., mode button)
        updateModeButtonVisuals();

        // Ensure buttons are in the correct state (not loading)
        setLoading(false);

        console.log("Game state loaded successfully.");
        // Save this newly loaded state locally as the user's 'own' state initially
        localGameState = captureGameState();
        // Optionally auto-save to localStorage after loading external state
        autoSaveGameState();

    } catch (error) {
        console.error("Error loading game state:", error);
        showError("An error occurred while loading the game state.");
    }
}


/**
 * Initializes the AudioContext if it doesn't exist.
 * Needs to be called ideally after a user interaction.
 */
function initAudioContext() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log("AudioContext initialized.");
            // Attempt to resume context if needed (often required after initial page load)
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
        } catch (e) {
            console.error("Web Audio API is not supported in this browser.", e);
            showError("Audio alerts are not supported in your browser.");
        }
    }
    // Ensure context is running
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(err => console.error("Error resuming audio context:", err));
    }
}

/**
 * Plays the turn alert sound using Web Audio API.
 */
function playTurnAlertSound() {
    // Initialize context if needed (best effort)
    initAudioContext();

    if (!audioCtx || audioCtx.state !== 'running') {
        console.warn("AudioContext not available or not running. Cannot play sound.");
        return;
    }

    const now = audioCtx.currentTime;
    const totalDuration = 1.0; // Total duration of the sound sequence

    // --- Foghorn Part ---
    const foghornOsc = audioCtx.createOscillator();
    const foghornGain = audioCtx.createGain();
    foghornOsc.type = 'sawtooth'; // A bit richer than sine
    foghornOsc.frequency.setValueAtTime(80, now); // Low frequency
    foghornGain.gain.setValueAtTime(0.3, now); // Start at moderate volume
    foghornGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5); // Fade out

    foghornOsc.connect(foghornGain);
    foghornGain.connect(audioCtx.destination);

    foghornOsc.start(now);
    foghornOsc.stop(now + 0.5);

    // --- Beep Part ---
    const beepOsc = audioCtx.createOscillator();
    const beepGain = audioCtx.createGain();
    beepOsc.type = 'square'; // Classic beep sound
    beepOsc.frequency.setValueAtTime(440, now + 0.6); // A4 note frequency
    beepGain.gain.setValueAtTime(0, now + 0.6); // Start silent
    beepGain.gain.linearRampToValueAtTime(0.2, now + 0.65); // Quick attack
    beepGain.gain.setValueAtTime(0.2, now + 0.75); // Hold briefly
    beepGain.gain.linearRampToValueAtTime(0, now + 0.8); // Quick decay (first beep end)

    // Second beep
    beepOsc.frequency.setValueAtTime(523, now + 0.85); // C5 note frequency (slightly higher)
    beepGain.gain.setValueAtTime(0, now + 0.85); // Start silent
    beepGain.gain.linearRampToValueAtTime(0.2, now + 0.9); // Quick attack
    beepGain.gain.setValueAtTime(0.2, now + totalDuration - 0.05); // Hold briefly
    beepGain.gain.linearRampToValueAtTime(0.001, now + totalDuration); // Quick decay

    beepOsc.connect(beepGain);
    beepGain.connect(audioCtx.destination);

    beepOsc.start(now + 0.6);
    beepOsc.stop(now + totalDuration);

    console.log("Playing turn alert sound.");
}


/** Updates the history queue with the previous turn's data. */
function updateHistoryQueue(playerActionsJson) {
    if (currentUiJson) {
        const previousTurnData = {
            ui: JSON.stringify(currentUiJson), // UI that was just displayed
            actions: playerActionsJson || "{}" // Actions that led to the *new* UI
        };
        if (historyQueue.length >= MAX_HISTORY_SIZE) {
            historyQueue.shift(); // Remove oldest entry if queue is full
        }
        historyQueue.push(previousTurnData);
        console.log(`Pushed previous turn to history. New Queue size: ${historyQueue.length}/${MAX_HISTORY_SIZE}`);
    }
}

/** Processes the successful response from the API. */
function processSuccessfulResponse(responseJson, playerActionsJson) {
    // Update the history queue with the *previous* turn's data *before* updating currentUiJson
    // Note: updateHistoryQueue is now called *before* sending the API request in fetchTurnData

    // Update the current UI state with the newly received data
    currentUiJson = responseJson;

    // Lock the API key input if this was the first successful call
    if (!apiKeyLocked) {
        apiKeyLocked = true;
        if (apiKeySection) {
            apiKeySection.style.display = 'none';
            console.log("API Key locked and input section hidden.");
        }
        // Enable save/reset buttons once the game has started and API key is locked
        saveGameButton.disabled = false;
        resetGameButton.disabled = false; // Enable reset button

        // Initialize multiplayer once the game starts and API key is confirmed
        initializeMultiplayer();
    }

    // Render the new UI (this will clear the uiContainer)
    renderUI(currentUiJson);
    console.log("renderUI finished.");

    // Capture the current state as the user's "own" state
    localGameState = captureGameState();

    // --- Play the alert sound ---
    playTurnAlertSound(); // <-- Play sound after rendering

    // --- Auto-save the game state after successfully processing and rendering the turn ---
    autoSaveGameState();

    // Broadcast the new state to connected peers
    broadcastGameState();
}


/**
 * Fetches the next turn's UI data from the Gemini API with retry/switching logic.
 * @param {string} playerActionsJson - JSON string of player actions from the turn just completed.
 */
async function fetchTurnData(playerActionsJson) {
    console.log("fetchTurnData called.");
    // Ensure AudioContext is ready (or attempted to be resumed) before fetching
    initAudioContext();

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showError("Please enter your Google AI API Key.");
        setLoading(false);
        if (apiKeySection && apiKeySection.style.display === 'none') {
            apiKeySection.style.display = 'block';
        }
        return;
    }

    setLoading(true);
    hideError(); // Clear previous errors
    const initialMsgEl = document.getElementById('initial-message');

    // Update history queue with the actions that led to the *current* state,
    // before fetching the *next* state.
    updateHistoryQueue(playerActionsJson);

    if (initialMsgEl) initialMsgEl.style.display = 'none'; // Hide initial message

    let success = false;
    let attempts = 0;
    // Allow trying each model twice + one extra attempt for the first model's first error
    const maxAttempts = AVAILABLE_MODELS.length * 2 + 1;
    let currentAttemptConsecutiveErrors = 0; // Tracks errors for the model *in this attempt sequence*

    while (!success && attempts < maxAttempts) {
        attempts++;
        const currentModel = AVAILABLE_MODELS[currentModelIndex];
        console.log(`Attempt ${attempts}/${maxAttempts}: Trying model ${currentModel} (Index: ${currentModelIndex})`);

        try {
            // Construct the prompt based on the turn number and history
            const fullPrompt = constructPrompt(playerActionsJson, historyQueue, isMasturbationMode);

            console.log(`Sending Prompt to ${currentModel}`);
            // console.log("Prompt Snippet:", fullPrompt.substring(0, 500) + "..."); // Log snippet for debugging

            const jsonStringResponse = await callRealGeminiAPI(apiKey, fullPrompt, currentModel); // Pass current model
            const responseJson = JSON.parse(jsonStringResponse);
            console.log(`Successfully parsed API response from ${currentModel}.`);

            // --- Process successful response ---
            // Pass the playerActionsJson that *led* to this response
            processSuccessfulResponse(responseJson, playerActionsJson);

            success = true; // Exit loop on success
            currentAttemptConsecutiveErrors = 0; // Reset local consecutive errors on success

        } catch (error) {
            console.error(`Error with model ${currentModel} (Attempt ${attempts}):`, error);
            currentAttemptConsecutiveErrors++;

            // --- Error Handling & Model Switching ---
            // Check for quota error (429) or specific message patterns
            const isQuotaError = error.message.includes('429') || /quota exceeded/i.test(error.message) || /resource has been exhausted/i.test(error.message);
            const shouldSwitch = isQuotaError || currentAttemptConsecutiveErrors >= 2;

            if (shouldSwitch && AVAILABLE_MODELS.length > 1) { // Only switch if there's more than one model
                const oldModel = AVAILABLE_MODELS[currentModelIndex];
                currentModelIndex = (currentModelIndex + 1) % AVAILABLE_MODELS.length;
                const newModel = AVAILABLE_MODELS[currentModelIndex];
                console.warn(`Switching model from ${oldModel} to ${newModel} due to ${isQuotaError ? 'quota/resource error' : '2 consecutive errors'}.`);
                showError(`Experiencing issues with ${oldModel}. Trying ${newModel}... (Attempt ${attempts + 1})`); // Show transient error
                currentAttemptConsecutiveErrors = 0; // Reset error count for the new model
                // Loop will continue with the new model index
            } else if (attempts < maxAttempts) {
                // Show non-switching error only if it's the first error for this model in this fetch attempt
                showError(`Temporary issue with ${currentModel}. Retrying... (Attempt ${attempts + 1})`);
                console.log(`Attempt ${attempts} failed, consecutive errors: ${currentAttemptConsecutiveErrors}. Retrying same model.`);
            } else {
                // Don't show retry message if it was the last attempt
                console.log(`Attempt ${attempts} failed, consecutive errors: ${currentAttemptConsecutiveErrors}. Max attempts reached.`);
            }

            // Optional: Add a small delay before retrying
            if (!success && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 750)); // 750ms delay
            }
        }
    } // End while loop

    if (!success) {
        console.error(`Failed to get response after ${maxAttempts} attempts.`);
        showError(`Failed to get response after ${maxAttempts} attempts across available models. Please check your API key, network connection, or try again later.`);
        // Keep previous UI displayed on persistent failure
        // Restore history by removing the last entry added before the failed attempt
        if (historyQueue.length > 0) {
            historyQueue.pop();
            console.log("Removed last history entry due to failed turn fetch.");
        }

    } else {
        hideError(); // Clear any transient error messages on final success
        window.scrollTo({top: 0, behavior: 'smooth'}); // Scroll on success
    }

    setLoading(false); // Set loading false *after* loop finishes
}


/**
 * Calls the real Google AI (Gemini) API.
 * @param {string} apiKey - The user's API Key.
 * @param {string} promptText - The full prompt text including instructions and history.
 * @param {string} modelName - The specific model to use for this call.
 * @returns {Promise<string>} - A promise resolving with the raw JSON string response from the API.
 */
async function callRealGeminiAPI(apiKey, promptText, modelName) { // Added modelName parameter
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`; // Use modelName in URL
    const requestBody = {
        contents: [{parts: [{text: promptText}]}],
        generationConfig: {
            temperature: 1.0,
            response_mime_type: "application/json",
        },
        safetySettings: [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
        ]
    };

    // console.log(`Calling Gemini API endpoint: ${API_URL}`);
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(requestBody),
    });
    // console.log("API Response Status:", response.status);

    if (!response.ok) {
        let errorBody = `API request failed (${response.status})`; // Include status in base message
        try {
            const errorJson = await response.json();
            errorBody += `: ${JSON.stringify(errorJson.error || errorJson)}`;
            console.error("API Error Body:", errorBody);
        } catch (parseError) {
            try {
                const errorText = await response.text();
                errorBody += `: ${errorText}`;
                console.error("Raw API Error Response:", errorText);
            } catch (textError) {
                console.error("Could not parse API error response body.");
            }
        }
        // Include status code in the error message for easier checking (e.g., 429 for quota)
        throw new Error(errorBody);
    }

    const responseData = await response.json();
    // console.log("Raw API Response Data:", JSON.stringify(responseData, null, 2));

    // Check for blocking reasons first
    if (responseData.promptFeedback && responseData.promptFeedback.blockReason) {
        console.error("API Request Blocked:", responseData.promptFeedback);
        throw new Error(`Request blocked by API. Reason: ${responseData.promptFeedback.blockReason}. Details: ${JSON.stringify(responseData.promptFeedback.safetyRatings || 'N/A')}`);
    }
    // Check if candidates exist
    if (!responseData.candidates || responseData.candidates.length === 0) {
        console.warn("Unexpected API response structure or no candidates:", JSON.stringify(responseData, null, 2));
        if (typeof responseData === 'string') {
            console.log("Response data is a string, attempting to parse directly.");
            try {
                JSON.parse(responseData); // Validate if it's JSON
                return responseData.trim();
            } catch (e) {
                throw new Error('No candidates generated, and the response itself was not valid JSON.');
            }
        }
        throw new Error('No candidates generated or unexpected API response structure.');
    }

    const candidate = responseData.candidates[0];

    // Check candidate finish reason
    if (candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
        if (candidate.finishReason === "SAFETY") {
            console.error("API Call Finished due to SAFETY:", candidate.safetyRatings);
            throw new Error(`API call finished due to SAFETY. Ratings: ${JSON.stringify(candidate.safetyRatings || 'N/A')}`);
        } else {
            console.warn(`API Call Finished Unexpectedly: ${candidate.finishReason}. Safety: ${JSON.stringify(candidate.safetyRatings || 'N/A')}`);
            // Allow processing if content exists despite finish reason
            // if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
            //     throw new Error(`API call finished unexpectedly (${candidate.finishReason}) and no content was returned.`);
            // }
        }
    }


    // Process content if available
    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        let generatedText = candidate.content.parts[0].text;
        // console.log("Raw API Generated Text:", generatedText);

        // Attempt to extract JSON from markdown code blocks first
        const jsonMatch = generatedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            generatedText = jsonMatch[1];
            console.log("Extracted JSON from markdown block.");
        }
        let trimmedText = generatedText.trim();

        try {
            // Attempt to parse the potentially extracted or raw text
            JSON.parse(trimmedText);
            return trimmedText; // Return the valid JSON string
        } catch (e) {
            console.error("API response is not valid JSON after potential extraction:", trimmedText, e);
            throw new Error(`Received invalid JSON structure from API. Snippet: ${trimmedText.substring(0, 200)}...`);
        }
    } else {
        console.warn("Candidate exists but has no content parts (or unexpected structure):", JSON.stringify(candidate, null, 2));
        // Consider the finish reason here - if it was e.g., SAFETY, this might be expected.
        if (candidate.finishReason === "SAFETY") {
            throw new Error(`API call finished due to SAFETY and returned no content. Ratings: ${JSON.stringify(candidate.safetyRatings || 'N/A')}`);
        }
        // Fallback error if no specific reason explains the lack of content
        throw new Error('API candidate generated but contained no content parts.');
    }
}


/**
 * Renders the UI elements onto the page based on the JSON array received from the API.
 * Extracts 'notes' and 'subjectId' into global variables.
 * @param {Array<object>} uiJsonArray - The array of UI element definitions.
 */
function renderUI(uiJsonArray) {
    console.log("renderUI started. Clearing container.");
    const initialMsgElementRef = document.getElementById('initial-message');
    uiContainer.innerHTML = ''; // Clear previous UI elements

    // Reset pending elements for combined rendering
    pendingPlayerAnalysis = null;
    pendingGeminiAnalysis = null;
    pendingTweetData = null;

    if (!Array.isArray(uiJsonArray)) {
        console.error("Invalid UI data received in renderUI: Expected an array.", uiJsonArray);
        showError("Received invalid UI data format from API (expected an array).");
        // Attempt to restore initial message if UI fails to render
        if (initialMsgElementRef) {
            const clonedInitialMsg = initialMsgElementRef.cloneNode(true);
            clonedInitialMsg.style.display = 'block'; // Make sure it's visible
            uiContainer.appendChild(clonedInitialMsg);
        }
        return;
    }
    console.log(`Rendering ${uiJsonArray.length} elements.`);

    // --- First pass: Extract special hidden fields and identify analysis/tweet ---
    uiJsonArray.forEach(element => {
        if (element.type === 'hidden') {
            if (element.name === 'notes') {
                currentNotes = element.value || null; // Store the notes string
                // console.log("Stored 'notes' hidden field.");
            } else if (element.name === 'subjectId') {
                currentSubjectId = element.value || "";
                // console.log("Updated Subject ID:", currentSubjectId);
            } else if (element.name === 'tweet') {
                pendingTweetData = element; // Identify tweet data
            }
            // Other hidden fields are ignored for rendering
        }
        // Identify analysis parts
        else if (element.type === 'text' && element.name === 'player_facing_analysis') {
            pendingPlayerAnalysis = element;
        } else if (element.type === 'text' && element.name === 'gemini_facing_analysis') {
            pendingGeminiAnalysis = element;
        }
    });


    // --- Second pass: Render all non-special, non-hidden elements ---
    uiJsonArray.forEach((element, index) => {
        // Skip elements already processed or identified for special rendering
        if (element.type === 'hidden' || element === pendingPlayerAnalysis || element === pendingGeminiAnalysis || element === pendingTweetData) {
            return;
        }
        renderSingleElement(element, index);
    });


    // --- Render combined analysis toggle if both parts exist ---
    if (pendingPlayerAnalysis && pendingGeminiAnalysis) {
        console.log("Rendering combined analysis toggle container.");
        renderAnalysisToggle(pendingPlayerAnalysis, pendingGeminiAnalysis);
    } else {
        // Render individually if only one exists (excluding hidden/special)
        if (pendingPlayerAnalysis && pendingPlayerAnalysis.type !== 'hidden') renderSingleElement(pendingPlayerAnalysis, -1);
        if (pendingGeminiAnalysis && pendingGeminiAnalysis.type !== 'hidden') renderSingleElement(pendingGeminiAnalysis, -1);
    }

    // --- Render hidden tweet element if it exists (will be positioned later) ---
    if (pendingTweetData) {
        console.log("Rendering hidden tweet element (initially hidden).");
        renderTweetElement(pendingTweetData); // This function now appends it
    }

    // --- Position the analysis toggle container right after the image ---
    const imageElement = uiContainer.querySelector('.geems-image-container');
    const analysisToggleContainer = uiContainer.querySelector('.analysis-toggle-container');
    if (imageElement && analysisToggleContainer) {
        if (imageElement.nextSibling) {
            uiContainer.insertBefore(analysisToggleContainer, imageElement.nextSibling);
        } else {
            uiContainer.appendChild(analysisToggleContainer);
        }
    }

    // --- Position the tweet element right after the analysis toggle container (or image as fallback) ---
    const tweetElement = document.getElementById('tweet-element-wrapper');
    if (tweetElement) {
        let positionRef = analysisToggleContainer || imageElement; // Prefer positioning after analysis
        if (positionRef) {
            if (positionRef.nextSibling) {
                uiContainer.insertBefore(tweetElement, positionRef.nextSibling);
            } else {
                uiContainer.appendChild(tweetElement);
            }
        } else {
            // If neither image nor analysis exists, tweet will remain appended at the end
            console.warn("Could not find suitable position for tweet element relative to image/analysis.");
        }
    }
    console.log("Finished rendering all elements.");
}


/**
 * Renders a single UI element (used by renderUI).
 * @param {object} element - The UI element definition.
 * @param {number} index - The index of the element in the array.
 */
function renderSingleElement(element, index) {
    const wrapper = document.createElement('div');
    wrapper.className = 'geems-element';
    if (element.voice) wrapper.classList.add(`voice-${element.voice}`);

    let adjustedColor = null;
    if (element.color && isValidHexColor(element.color)) {
        adjustedColor = adjustColorForContrast(element.color);
        wrapper.style.borderLeftColor = adjustedColor;
        // Apply border color to toggle container as well
        if (wrapper.classList.contains('analysis-toggle-container')) {
            wrapper.style.borderColor = adjustedColor;
        }
    } else {
        wrapper.style.borderLeftColor = 'transparent'; // Default or fallback
    }

    try {
        switch (element.type) {
            case 'image':
                renderImage(wrapper, element, adjustedColor);
                break;
            case 'text':
                // Ensure analysis text isn't rendered twice if part of a toggle
                if (element !== pendingPlayerAnalysis && element !== pendingGeminiAnalysis) {
                    renderText(wrapper, element, adjustedColor);
                } else {
                    return; // Skip rendering here, handled by renderAnalysisToggle or fallback
                }
                break;
            case 'textfield':
                renderTextField(wrapper, element, adjustedColor);
                break;
            case 'checkbox':
                renderCheckbox(wrapper, element, adjustedColor);
                break;
            case 'slider':
                renderSlider(wrapper, element, adjustedColor);
                break;
            case 'radio':
                renderRadio(wrapper, element, adjustedColor);
                break;
            // Hidden case removed - handled in the first pass of renderUI
            default:
                console.warn("Rendering unknown element type:", element.type, element);
                wrapper.textContent = `Unknown element type: ${element.type}`;
                wrapper.style.color = 'red';
        }
        // Append the wrapper only if it wasn't skipped (e.g., analysis parts, hidden)
        uiContainer.appendChild(wrapper);
    } catch (renderError) {
        console.error(`Error rendering element ${index} (type: ${element.type}, name: ${element.name}):`, renderError, element);
        const errorWrapper = document.createElement('div');
        errorWrapper.className = 'geems-element error-message';
        errorWrapper.textContent = `Error rendering element: ${element.name || element.type}. Check console.`;
        uiContainer.appendChild(errorWrapper);
    }
}


// --- UI Element Rendering Functions ---

/**
 * Renders an image element.
 * Generates a random seed and includes nologo=true, safe=false.
 * @param {HTMLElement} wrapper - The container div for the element.
 * @param {object} element - The UI element definition.
 * @param {string|null} adjustedColor - The contrast-adjusted color.
 */
function renderImage(wrapper, element, adjustedColor) {
    wrapper.classList.add('geems-image-container'); // Use specific class for image container
    wrapper.classList.remove('geems-element'); // Remove general padding/border for image container itself
    wrapper.style.borderLeftColor = 'transparent'; // No left border for the container


    const img = document.createElement('img');
    img.className = 'geems-image'; // Use specific class for image styling
    const imagePrompt = element.value || 'abstract image';
    // Generate random seed for each game turn image
    const randomSeed = Math.floor(Math.random() * 65536);
    // Construct URL with random seed, nologo=true, safe=false
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?nologo=true&safe=false&seed=${randomSeed}`;
    img.src = imageUrl;
    img.alt = element.label || `Image: ${imagePrompt.substring(0, 50)}...`;
    // Add error handling for the image
    img.onerror = () => {
        console.warn(`Failed to load image: ${imageUrl}. Prompt: ${imagePrompt}`);
        img.src = `https://placehold.co/600x400/e0e7ff/4f46e5?text=Image+Load+Error`; // Placeholder on error
        img.alt = `Error loading image: ${imagePrompt.substring(0, 50)}...`;
    };
    wrapper.appendChild(img);

    // Render label below image if provided
    if (element.label) {
        const labelDiv = document.createElement('div');
        labelDiv.className = 'geems-label text-center font-semibold mt-2'; // Center label below image
        if (adjustedColor) labelDiv.style.color = adjustedColor;
        labelDiv.textContent = element.label;
        wrapper.appendChild(labelDiv);
    }
    // Render the prompt text below the label/image
    const promptText = document.createElement('p');
    promptText.className = 'geems-image-prompt'; // Specific class for prompt text styling
    promptText.textContent = imagePrompt
    wrapper.appendChild(promptText);
}

/**
 * Renders a text element, handling labels and basic Markdown.
 * @param {HTMLElement} wrapper - The container div for the element.
 * @param {object} element - The UI element definition.
 * @param {string|null} adjustedColor - The contrast-adjusted color.
 */
function renderText(wrapper, element, adjustedColor) {
    const textContent = element.text || element.value || '';
    // Determine if a label should be shown (exclude specific named text elements)
    const useLabel = element.label && !['narrative', 'divine_wisdom', 'player_facing_analysis', 'gemini_facing_analysis'].some(namePart => element.name?.includes(namePart));

    if (useLabel) {
        const label = document.createElement('label');
        label.className = 'geems-label';
        if (adjustedColor) label.style.color = adjustedColor;
        label.textContent = element.label;
        wrapper.appendChild(label);
    }
    const textElement = document.createElement('div');
    textElement.className = 'geems-text';
    // Basic Markdown parsing (bold, italics, code blocks, newlines)
    textElement.innerHTML = textContent
        .replace(/&/g, "&amp;") // Escape existing ampersands first
        .replace(/</g, "&lt;")  // Escape <
        .replace(/>/g, "&gt;")  // Escape >
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
        .replace(/\*(.*?)\*/g, '<em>$1</em>')       // Italics
        .replace(/```([\s\S]*?)```/g, (match, p1) => `<pre>${p1.trim()}</pre>`) // Code blocks (no extra escaping needed now)
        .replace(/\n/g, '<br>'); // Newlines
    wrapper.appendChild(textElement);
}

/**
 * Renders a text field (textarea) element.
 * @param {HTMLElement} wrapper - The container div for the element.
 * @param {object} element - The UI element definition.
 * @param {string|null} adjustedColor - The contrast-adjusted color.
 */
function renderTextField(wrapper, element, adjustedColor) {
    const label = document.createElement('label');
    label.className = 'geems-label';
    label.textContent = element.label || element.name; // Use name as fallback label
    label.htmlFor = element.name; // Associate label with input
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);

    const input = document.createElement('textarea');
    input.className = 'geems-textarea'; // Use specific class for textarea styling
    input.id = element.name;
    input.name = element.name;
    input.rows = 4; // Default rows
    input.value = element.value || ''; // Pre-fill value if provided
    input.placeholder = element.placeholder || 'Type your response here...';
    input.dataset.elementType = 'textfield'; // Mark element type for collection
    wrapper.appendChild(input);
}

/**
 * Renders a checkbox element.
 * @param {HTMLElement} wrapper - The container div for the element.
 * @param {object} element - The UI element definition.
 * @param {string|null} adjustedColor - The contrast-adjusted color.
 */
function renderCheckbox(wrapper, element, adjustedColor) {
    // Checkbox doesn't need the outer .geems-element padding/border
    wrapper.classList.remove('geems-element');
    wrapper.style.borderLeftColor = 'transparent';
    wrapper.style.padding = '0';
    wrapper.style.marginBottom = '0.75rem'; // Add margin directly

    const optionDiv = document.createElement('div');
    optionDiv.className = 'geems-checkbox-option'; // Use specific class for checkbox option styling

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = element.name;
    input.name = element.name;
    // Check based on boolean true or string 'true'
    input.checked = element.value === true || String(element.value).toLowerCase() === 'true';
    input.dataset.elementType = 'checkbox'; // Mark element type
    if (adjustedColor) input.style.accentColor = adjustedColor; // Style checkbox color

    const label = document.createElement('label');
    label.htmlFor = element.name;
    label.textContent = element.label || element.name; // Use name as fallback label
    // Removed color styling from label - it inherits from parent
    label.className = "flex-grow cursor-pointer"; // Simpler class

    optionDiv.appendChild(input);
    optionDiv.appendChild(label);
    wrapper.appendChild(optionDiv); // Append the whole option div to the main wrapper
}

/**
 * Renders a slider (range input) element.
 * @param {HTMLElement} wrapper - The container div for the element.
 * @param {object} element - The UI element definition.
 * @param {string|null} adjustedColor - The contrast-adjusted color.
 */
function renderSlider(wrapper, element, adjustedColor) {
    const label = document.createElement('label');
    label.className = 'geems-label';
    label.textContent = element.label || element.name; // Use name as fallback label
    label.htmlFor = element.name;
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);

    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'flex items-center space-x-4 mt-2'; // Layout for slider and value

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'geems-slider flex-grow'; // Use specific class for slider styling
    input.id = element.name;
    input.name = element.name;
    const min = parseFloat(element.min) || 0; // Default min 0
    const max = parseFloat(element.max) || 10; // Default max 10
    input.min = min;
    input.max = max;
    input.step = element.step || 1; // Default step 1
    // Pre-fill value, ensuring it's within min/max bounds, default to midpoint if invalid
    const defaultValue = parseFloat(element.value);
    input.value = isNaN(defaultValue) ? (min + max) / 2 : Math.max(min, Math.min(max, defaultValue));
    input.dataset.elementType = 'slider'; // Mark element type
    // Apply adjusted color to slider thumb/track
    if (adjustedColor) {
        input.style.accentColor = adjustedColor;
        // Custom property for thumb color (might need browser-specific prefixes in real CSS)
        input.style.setProperty('--slider-thumb-color', adjustedColor);
        // Ensure style attribute exists before appending
        input.setAttribute('style', `${input.getAttribute('style') || ''} --slider-thumb-color: ${adjustedColor};`);
    }

    const valueDisplay = document.createElement('span');
    valueDisplay.className = `geems-slider-value-display font-medium w-auto text-right`; // Use auto width
    valueDisplay.textContent = input.value; // Show initial value
    if (adjustedColor) valueDisplay.style.color = adjustedColor;

    // Update value display on slider input
    input.oninput = () => {
        valueDisplay.textContent = input.value;
    };

    sliderContainer.appendChild(input);
    sliderContainer.appendChild(valueDisplay);
    wrapper.appendChild(sliderContainer); // Append the container to the main wrapper
}

/**
 * Renders a radio button group element.
 * Handles options provided as JSON string array or single string.
 * @param {HTMLElement} wrapper - The container div for the element.
 * @param {object} element - The UI element definition.
 * @param {string|null} adjustedColor - The contrast-adjusted color.
 */
function renderRadio(wrapper, element, adjustedColor) {
    // Radio group doesn't need the outer .geems-element padding/border
    wrapper.classList.remove('geems-element');
    wrapper.style.borderLeftColor = 'transparent';
    wrapper.style.padding = '0';
    wrapper.style.marginBottom = '0.75rem'; // Add margin directly

    const label = document.createElement('label');
    label.className = 'geems-label block mb-2'; // Ensure label is block and add margin
    label.textContent = element.label || element.name; // Use name as fallback label
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);

    let options = [];
    let defaultValue = null;
    // Options can be in element.options or element.value
    let optionsSource = element.options || element.value;

    try {
        // If optionsSource is a string, try parsing it as JSON array
        if (typeof optionsSource === 'string') {
            try {
                optionsSource = JSON.parse(optionsSource);
            } catch (e) {
                // If parsing fails, treat the string as a single option
                optionsSource = [{label: optionsSource, value: optionsSource}];
                console.warn(`Radio options for '${element.name}' was a string, treating as single option:`, optionsSource);
            }
        }

        // Process if optionsSource is now an array
        if (Array.isArray(optionsSource)) {
            options = optionsSource.map(opt => {
                let currentLabel = '', currentValue = '', isDefault = false;
                // Handle object format {label: "...", value: "..."}
                if (typeof opt === 'object' && opt !== null && opt.value !== undefined) {
                    currentValue = String(opt.value);
                    currentLabel = opt.label !== undefined ? String(opt.label) : currentValue; // Use value if label missing
                    // Check for '*' prefix indicating default in label
                    if (currentLabel.startsWith('*')) {
                        defaultValue = currentValue;
                        currentLabel = currentLabel.substring(1); // Remove '*' from label
                        isDefault = true;
                    }
                }
                // Handle simple string format "Option" or "*Default Option"
                else {
                    currentValue = String(opt);
                    currentLabel = currentValue;
                    // Check for '*' prefix indicating default
                    if (currentLabel.startsWith('*')) {
                        defaultValue = currentValue.substring(1); // Remove '*' from value and label
                        currentValue = defaultValue;
                        currentLabel = defaultValue;
                        isDefault = true;
                    }
                }
                return {value: currentValue, label: currentLabel, isDefault: isDefault};
            }).filter(opt => opt !== null); // Filter out any potential nulls

            // If no default was marked with '*', check if element.value matches an option value
            if (defaultValue === null && element.value && typeof element.value === 'string') {
                // Avoid trying to parse element.value if it was already the source of options
                let isValueSimpleString = true;
                try {
                    if (Array.isArray(JSON.parse(element.value))) isValueSimpleString = false;
                } catch (e) { /* ignore parse error */
                }

                if (isValueSimpleString) {
                    const directValueMatch = options.find(opt => opt.value === element.value);
                    if (directValueMatch) {
                        defaultValue = directValueMatch.value; // Set default based on element.value match
                    }
                }
            }

        } else {
            console.warn("Unexpected format for radio options:", element.name, optionsSource);
        }
    } catch (e) {
        console.error("Failed to process radio options:", element.name, e);
    }

    // If still no default, and options exist, pick the first one
    if (defaultValue === null && options.length > 0) {
        defaultValue = options[0].value;
    }

    // Render each radio button option
    if (options.length > 0) {
        options.forEach((option, index) => {
            const optionDiv = document.createElement('div');
            optionDiv.className = 'geems-radio-option'; // Use specific class for radio option styling

            const input = document.createElement('input');
            input.type = 'radio';
            const inputId = `${element.name}_${index}`; // Unique ID for each radio input
            input.id = inputId;
            input.name = element.name; // All radios in group share the same name
            input.value = option.value;
            input.checked = (option.value === defaultValue); // Check if this is the default
            input.dataset.elementType = 'radio'; // Mark element type
            if (adjustedColor) input.style.accentColor = adjustedColor; // Style radio button color

            const optionLabel = document.createElement('label');
            optionLabel.htmlFor = inputId; // Associate label with input
            optionLabel.textContent = option.label;
            // Removed color styling from label - it inherits from parent
            optionLabel.className = "flex-grow cursor-pointer"; // Simpler class

            optionDiv.appendChild(input);
            optionDiv.appendChild(optionLabel);
            wrapper.appendChild(optionDiv); // Append the option div to the main wrapper
        });
    } else {
        // Show error if no valid options were found
        wrapper.innerHTML += `<p class="text-sm text-red-600">Error: No valid options found for radio group '${element.name}'.</p>`;
    }
}

/**
 * Renders a toggle container for player and Gemini analysis text.
 * @param {object} playerAnalysisElem - The player-facing analysis element definition.
 * @param {object} geminiAnalysisElem - The Gemini-facing analysis element definition.
 */
function renderAnalysisToggle(playerAnalysisElem, geminiAnalysisElem) {
    const wrapper = document.createElement('div');
    wrapper.className = 'geems-element analysis-toggle-container'; // Specific class for toggle styling
    // Inherit voice class if present on Gemini analysis
    if (geminiAnalysisElem.voice) wrapper.classList.add(`voice-${geminiAnalysisElem.voice}`);

    // Determine border color based on Gemini analysis color or default
    const rawColor = (geminiAnalysisElem.color && isValidHexColor(geminiAnalysisElem.color)) ? geminiAnalysisElem.color : '#10b981'; // Default green
    const borderColor = adjustColorForContrast(rawColor);
    wrapper.style.borderColor = borderColor; // Apply color to all borders of the toggle

    // Create div for player analysis (initially visible)
    const playerDiv = document.createElement('div');
    playerDiv.className = 'analysis-content player-analysis';
    playerDiv.style.display = 'block'; // Player analysis shown by default
    renderAnalysisContent(playerDiv, playerAnalysisElem, borderColor); // Render content inside

    // Create div for Gemini analysis (initially hidden)
    const geminiDiv = document.createElement('div');
    geminiDiv.className = 'analysis-content gemini-analysis';
    geminiDiv.style.display = 'none'; // Gemini analysis hidden by default
    renderAnalysisContent(geminiDiv, geminiAnalysisElem, borderColor); // Render content inside

    // Create toggle icon (using Lucide font class)
    const icon = document.createElement('i');
    icon.className = 'lucide lucide-repeat analysis-toggle-icon'; // Icon class
    // Set custom property for hover color if border color is valid
    if (borderColor) wrapper.style.setProperty('--toggle-hover-color', borderColor);

    // Append elements to wrapper
    wrapper.appendChild(playerDiv);
    wrapper.appendChild(geminiDiv);
    wrapper.appendChild(icon);

    // Add click listener to toggle visibility
    wrapper.addEventListener('click', (event) => {
        // Prevent toggling if click is inside a <pre> block (e.g., selecting text)
        if (event.target.closest('pre')) return;

        const isPlayerVisible = playerDiv.style.display !== 'none';
        playerDiv.style.display = isPlayerVisible ? 'none' : 'block'; // Toggle player div
        geminiDiv.style.display = isPlayerVisible ? 'block' : 'none'; // Toggle gemini div

        // Also toggle visibility of the associated tweet element
        const tweetWrapper = document.getElementById('tweet-element-wrapper');
        if (tweetWrapper) tweetWrapper.style.display = geminiDiv.style.display; // Match tweet visibility to Gemini analysis

        // Rotate icon based on which analysis is visible
        icon.style.transform = geminiDiv.style.display !== 'none' ? 'translateY(-50%) rotate(180deg)' : 'translateY(-50%) rotate(0deg)';
    });
    // Note: Appending to uiContainer happens in renderUI after initial rendering pass
}

/**
 * Renders the content (label and text) inside an analysis div.
 * @param {HTMLElement} containerDiv - The div to render content into (player or gemini).
 * @param {object} analysisElement - The analysis element definition.
 * @param {string} borderColor - The adjusted border color for styling.
 */
function renderAnalysisContent(containerDiv, analysisElement, borderColor) {
    const textContent = analysisElement.text || analysisElement.value || '';
    // Render label if provided
    if (analysisElement.label) {
        const analysisLabel = document.createElement('div');
        analysisLabel.className = 'geems-label font-semibold mb-2'; // Analysis label styling
        if (borderColor) {
            analysisLabel.style.color = borderColor; // Use border color for label
            analysisLabel.style.borderBottomColor = borderColor; // Use border color for underline
        }
        analysisLabel.textContent = analysisElement.label;
        containerDiv.appendChild(analysisLabel);
    }
    // Render text content with basic Markdown
    const textElement = document.createElement('div');
    textElement.className = 'geems-text';
    // Basic Markdown parsing (bold, italics, code blocks, newlines) - Ensure escaping first
    textElement.innerHTML = textContent
        .replace(/&/g, "&amp;") // Escape existing ampersands first
        .replace(/</g, "&lt;")  // Escape <
        .replace(/>/g, "&gt;")  // Escape >
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
        .replace(/\*(.*?)\*/g, '<em>$1</em>')       // Italics
        .replace(/```([\s\S]*?)```/g, (match, p1) => `<pre>${p1.trim()}</pre>`) // Code blocks (no extra escaping needed now)
        .replace(/\n/g, '<br>'); // Newlines
    containerDiv.appendChild(textElement);
}

/**
 * Renders the hidden tweet element, initially hidden. Appends to uiContainer.
 * @param {object} tweetData - The hidden tweet element definition.
 */
function renderTweetElement(tweetData) {
    const wrapper = document.createElement('div');
    wrapper.id = 'tweet-element-wrapper'; // ID for targeting
    wrapper.className = 'geems-element'; // Basic element styling
    wrapper.style.display = 'none'; // Initially hidden

    // Add a label for the tweet stream
    const label = document.createElement('div');
    label.className = 'geems-label';
    label.textContent = 'Gemini\'s Internal Tweet Stream:';
    wrapper.appendChild(label);

    // Add the tweet content
    const tweetContent = document.createElement('div');
    tweetContent.className = 'geems-text';
    tweetContent.textContent = tweetData.value || 'No tweet content.';
    wrapper.appendChild(tweetContent);

    // Append to the main UI container; positioning happens later in renderUI
    uiContainer.appendChild(wrapper);
}


// --- Utility Functions ---

/** Collects the current state of all interactive UI elements. */
function collectInputState() {
    const inputs = {};
    // Select all elements marked with 'data-element-type'
    uiContainer.querySelectorAll('[data-element-type]').forEach(el => {
        const name = el.name;
        if (!name) return; // Skip elements without a name
        const type = el.dataset.elementType;
        switch (type) {
            case 'textfield':
                inputs[name] = el.value;
                break;
            case 'checkbox':
                inputs[name] = el.checked; // Store boolean value
                break;
            case 'slider':
                inputs[name] = parseFloat(el.value); // Store numeric value
                break;
            case 'radio':
                if (el.checked) { // Only store the value of the selected radio button
                    inputs[name] = el.value;
                }
                break;
        }
    });
    // Add the current turn number (based on history length *before* this turn)
    inputs['turn'] = historyQueue.length + 1;
    // console.log("Collected Inputs:", inputs);
    return JSON.stringify(inputs); // Return as JSON string
}

/** Sets the loading state for the UI. */
function setLoading(loading) {
    isLoading = loading;
    loadingIndicator.style.display = loading ? 'flex' : 'none'; // Show/hide loading spinner

    // Determine if API key is present (needed for enabling submit button)
    const keyPresent = apiKeyInput.value.trim().length > 0;

    // Enable/disable main action buttons based on loading state and game state
    submitButton.disabled = loading || !(apiKeyLocked || keyPresent); // Submit enabled if not loading AND (game started OR key present)
    saveGameButton.disabled = loading || !apiKeyLocked; // Save enabled if not loading AND game started
    modeToggleButton.disabled = loading; // Mode toggle disabled during loading
    resetGameButton.disabled = loading || !apiKeyLocked; // Reset enabled if not loading AND game started

    // Disable/enable all interactive UI elements within the game container
    uiContainer.querySelectorAll('input, textarea, button, .analysis-toggle-container, .geems-radio-option, .geems-checkbox-option').forEach(el => {
        // Exclude the main footer buttons from this generic disabling logic
        if (el.id !== 'submit-turn' && el.id !== 'saveGameButton' && el.id !== 'modeToggleButton' && el.id !== 'resetGameButton') {
            // Disable form elements directly
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON') {
                el.disabled = loading;
            }
            // Dim and disable pointer events for custom styled elements/containers
            if (el.classList.contains('geems-radio-option') || el.classList.contains('geems-checkbox-option') || el.classList.contains('analysis-toggle-container') || el.closest('.geems-slider-container')) { // Include slider container
                el.style.opacity = loading ? 0.5 : 1.0;
                el.style.pointerEvents = loading ? 'none' : 'auto';
                // Explicitly disable sliders within the container
                el.querySelectorAll('.geems-slider').forEach(slider => slider.disabled = loading);
            }
        }
    });
}

/** Displays an error message. */
function showError(message) {
    errorDisplay.textContent = message;
    errorDisplay.style.display = 'block'; // Make error visible
}

/** Hides the error message. */
function hideError() {
    errorDisplay.textContent = '';
    errorDisplay.style.display = 'none'; // Make error hidden
}

/** Checks if a string is a valid hex color code. */
function isValidHexColor(hex) {
    return typeof hex === 'string' && /^#[0-9A-F]{6}$/i.test(hex);
}

/** Adjusts a hex color to ensure minimum lightness contrast against a light background. */
function adjustColorForContrast(hex) {
    if (!isValidHexColor(hex)) return hex; // Return original if invalid

    // Convert hex to HSL
    let r = parseInt(hex.substring(1, 3), 16), g = parseInt(hex.substring(3, 5), 16),
        b = parseInt(hex.substring(5, 7), 16);
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2; // Calculate lightness, initialize h, s

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min); // Calculate saturation
        switch (max) { // Calculate hue
            case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            case b:
                h = (r - g) / d + 4;
                break;
        }
        h /= 6;
    }

    // If lightness is too high (adjust MIN_CONTRAST_LIGHTNESS as needed)
    if (l > MIN_CONTRAST_LIGHTNESS) {
        l = MIN_CONTRAST_LIGHTNESS * 0.9; // Reduce lightness

        // Convert HSL back to RGB
        let r1, g1, b1;
        if (s === 0) {
            r1 = g1 = b1 = l; // achromatic
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r1 = hue2rgb(p, q, h + 1 / 3);
            g1 = hue2rgb(p, q, h);
            b1 = hue2rgb(p, q, h - 1 / 3);
        }

        // Convert RGB back to Hex
        const toHex = x => {
            const hexVal = Math.round(x * 255).toString(16);
            return hexVal.length === 1 ? '0' + hexVal : hexVal; // Pad with zero if needed
        };
        return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
    }
    return hex; // Return original hex if contrast is already sufficient
}

/** Displays a temporary message related to clipboard actions. */
function showClipboardMessage(message, isError = false) {
    clipboardMessage.textContent = message;
    clipboardMessage.style.color = isError ? '#dc2626' : '#16a34a'; // Red for error, Green for success
    // Clear message after 3 seconds
    setTimeout(() => {
        clipboardMessage.textContent = '';
    }, 3000);
}

/** Updates the visual appearance and text of the mode toggle button. */
function updateModeButtonVisuals() {
    if (isMasturbationMode) {
        modeToggleButton.textContent = 'Mode: Explicit';
        modeToggleButton.classList.remove('standard-mode');
    } else {
        modeToggleButton.textContent = 'Mode: Standard';
        modeToggleButton.classList.add('standard-mode'); // Add green class
    }
}

/**
 * Sets the header, footer, and potentially footer icon images using Pollinations AI with random seeds.
 * Includes nologo=true and safe=false parameters.
 */
function setDynamicImages() {
    // Generate random seeds (0-65535)
    const headerSeed = Math.floor(Math.random() * 65536);
    const footerSeed = Math.floor(Math.random() * 65536);
    // const iconSeed = Math.floor(Math.random() * 65536); // Seed for icon if used

    // Define image prompts
    const headerPrompt = "wide cinematic vivid colorful abstract emotional landscape brainwaves";
    const footerPrompt = "wide abstract colorful digital roots network connections";
    // const iconPrompt = "pixel art floppy disk"; // Icon prompt if used

    // Update Header Banner image source and alt text
    if (headerBanner) {
        headerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(headerPrompt)}?width=1200&height=200&seed=${headerSeed}&nologo=true&safe=false`;
        headerBanner.alt = headerPrompt;
    }

    // Update Footer Banner image source and alt text
    if (footerBanner) {
        footerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(footerPrompt)}?width=1200&height=100&seed=${footerSeed}&nologo=true&safe=false`;
        footerBanner.alt = footerPrompt;
    }

    // Update Footer Icon image source and alt text (if the element exists)
    if (footerIconImage) {
        // footerIconImage.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(iconPrompt)}?width=60&height=60&seed=${iconSeed}&nologo=true&safe=false`;
        // footerIconImage.alt = iconPrompt;
    } else {
        // console.log("Footer icon image element not found.") // Optional log
    }
}

// --- Multiplayer Functions ---

/** Initializes the PeerJS connection process */
function initializeMultiplayer() {
    console.log("Initializing multiplayer...");

    // --- Attempt to become the host ---
    peer = new Peer(HOST_UUID, { debug: 1 }); // Use debug level 1 for moderate logs

    peer.on('open', (id) => {
        localPeerId = id;
        console.log(`PeerJS opened. My ID is: ${id}. Attempted Host ID: ${HOST_UUID}`);
        updatePlayerIcons(); // Add own icon

        if (id === HOST_UUID) {
            // Successfully became the host
            hostPeerId = id;
            console.log("Successfully became the HOST!");
            showStatusUpdate("Hosting game session.");
        } else {
            // Host ID was taken, or PeerJS assigned a random one. Connect to the host.
            console.log("Host ID taken or unavailable. Connecting to host:", HOST_UUID);
            showStatusUpdate(`Connected as ${id.slice(-4)}. Joining host...`);
            connectToPeer(HOST_UUID);
        }
        setupCommonPeerListeners(peer); // Setup listeners regardless of host/client
    });

    peer.on('error', (err) => {
        console.error("PeerJS error during initial host attempt:", err);
        // If host ID is unavailable, try initializing as a client explicitly
        if (err.type === 'unavailable-id' || err.type === 'browser-incompatible' || err.type === 'disconnected' || err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed' || err.type === 'invalid-id' || err.type === 'invalid-key') {
            console.log("Host attempt failed. Initializing as client...");
            if (peer && !peer.destroyed) peer.destroy(); // Clean up previous attempt
            initializeAsClient();
        } else {
            showError(`Multiplayer connection error: ${err.type}. Try refreshing.`);
            resetMultiplayerState();
        }
    });
}

/** Initializes PeerJS as a client (when host ID is taken) */
function initializeAsClient() {
    // Pass undefined ID to get a random one from PeerJS
    peer = new Peer(undefined, { debug: 1 });

    peer.on('open', (id) => {
        localPeerId = id;
        console.log(`PeerJS opened as CLIENT. My ID is: ${id}`);
        showStatusUpdate(`Joined as ${id.slice(-4)}. Connecting to host...`);
        updatePlayerIcons(); // Add own icon
        connectToPeer(HOST_UUID); // Connect to the known host UUID
        setupCommonPeerListeners(peer); // Setup listeners
    });

    peer.on('error', (err) => {
        console.error("PeerJS client initialization error:", err);
        showError(`Multiplayer client error: ${err.type}. Try refreshing.`);
        resetMultiplayerState();
    });
}


/** Sets up common PeerJS event listeners */
function setupCommonPeerListeners(peerInstance) {
    if (!peerInstance) return;

    // Handle incoming connections (other clients connecting to us, or host connecting back)
    peerInstance.on('connection', (conn) => {
        console.log(`Incoming connection from ${conn.peer}`);
        setupConnectionListeners(conn);
    });

    peerInstance.on('disconnected', () => {
        console.warn("PeerJS disconnected from signaling server.");
        showStatusUpdate("Network disconnected. Attempting to reconnect...");
        // Attempt to reconnect automatically
        if (peerInstance && !peerInstance.destroyed && !peerInstance.disconnected) {
            peerInstance.reconnect();
        } else if (!peerInstance.destroyed) {
            // If fully disconnected, might need re-initialization
            console.error("Cannot reconnect, peer is destroyed or disconnected.");
            resetMultiplayerState(); // Or attempt full re-initialization
            // initializeMultiplayer(); // Could cause loops if server is down
        }
    });

    peerInstance.on('close', () => {
        console.error("PeerJS connection closed permanently.");
        showError("Multiplayer connection closed. Please refresh.");
        resetMultiplayerState();
    });

    // Generic error handler for the peer instance
    peerInstance.on('error', (err) => {
        // Avoid double-logging errors handled during init
        if (err.type !== 'unavailable-id' && !err.message.includes("Could not connect to peer")) { // Filter common connect errors handled elsewhere
            console.error(`General PeerJS error: ${err.type}`, err);
            // Avoid showing generic errors if specific ones were already shown
            if (errorDisplay.style.display === 'none') {
                showError(`Multiplayer error: ${err.type}.`);
            }
        }
        // Handle peer unavailable specifically during runtime
        if (err.type === 'peer-unavailable') {
            const unavailablePeerId = err.message?.match(/peer\s(.*?)\s/)?.[1];
            if (unavailablePeerId) {
                console.warn(`Peer ${unavailablePeerId} is unavailable.`);
                removeConnection(unavailablePeerId); // Clean up connection map
                if (unavailablePeerId === hostPeerId) {
                    showError("Host disconnected.");
                    // Simple strategy: attempt to reconnect / re-initialize
                    resetMultiplayerState();
                    initializeMultiplayer();
                }
            }
        }
    });
}

/** Connects to a specific peer ID */
function connectToPeer(targetPeerId) {
    if (!peer || peer.destroyed || !targetPeerId || targetPeerId === localPeerId || connections.has(targetPeerId)) {
        console.log(`Skipping connection attempt to ${targetPeerId}: Peer invalid, self, or already connected/connecting.`);
        return;
    }
    console.log(`Attempting to connect to: ${targetPeerId}`);
    try {
        const conn = peer.connect(targetPeerId, { reliable: true });
        connections.set(targetPeerId, conn); // Add connection immediately
        updatePlayerIcons(); // Update icons optimistically
        setupConnectionListeners(conn);
    } catch (e) {
        console.error(`Error initiating connection to ${targetPeerId}:`, e);
        connections.delete(targetPeerId); // Clean up if connection object creation failed
        updatePlayerIcons();
    }
}

/** Sets up listeners for a specific DataConnection */
function setupConnectionListeners(conn) {
    const remotePeerId = conn.peer;
    conn.on('open', () => {
        console.log(`Connection established with: ${remotePeerId}`);
        connections.set(remotePeerId, conn); // Ensure connection object is stored
        if (!hostPeerId) hostPeerId = remotePeerId; // Assume first connection is host if we aren't
        showStatusUpdate(`Player ${remotePeerId.slice(-4)} joined.`);
        updatePlayerIcons();

        // Request initial state from host upon connecting
        if (remotePeerId === hostPeerId && hostPeerId !== localPeerId) {
            console.log("Requesting initial state from host.");
            sendDirectMessage(hostPeerId, { type: 'request_initial_state' });
        }
    });

    conn.on('data', (data) => {
        console.log(`Data received from ${remotePeerId}:`, data);
        handleReceivedData(remotePeerId, data);
    });

    conn.on('close', () => {
        console.log(`Connection closed with: ${remotePeerId}`);
        removeConnection(remotePeerId);
        showStatusUpdate(`Player ${remotePeerId.slice(-4)} left.`);
        if (remotePeerId === hostPeerId) {
            showError("Host connection lost.");
            // Implement host migration logic or reset here if needed
            resetMultiplayerState();
            initializeMultiplayer(); // Attempt re-init
        }
    });

    conn.on('error', (err) => {
        console.error(`Connection error with ${remotePeerId}:`, err);
        showError(`Network error with player ${remotePeerId.slice(-4)}.`);
        removeConnection(remotePeerId);
        if (remotePeerId === hostPeerId) {
            showError("Host connection error.");
            resetMultiplayerState();
            initializeMultiplayer(); // Attempt re-init
        }
    });
}

/** Removes a connection and updates UI */
function removeConnection(peerIdToRemove) {
    if (connections.has(peerIdToRemove)) {
        const conn = connections.get(peerIdToRemove);
        if (conn && typeof conn.close === 'function') {
            conn.close(); // Close the connection object
        }
        connections.delete(peerIdToRemove);
        console.log(`Removed connection to ${peerIdToRemove}. Total: ${connections.size}`);
        updatePlayerIcons();
    }
}

/** Handles data received from peers */
function handleReceivedData(senderId, data) {
    if (!data || !data.type) {
        console.warn("Received malformed data:", data);
        return;
    }

    switch (data.type) {
        case 'game_state':
            console.log(`Received game state from ${senderId.slice(-4)}`);
            if (data.payload) {
                loadGameState(data.payload);
                showStatusUpdate(`Loaded state from ${senderId.slice(-4)}.`);
            } else {
                console.warn("Received game_state message without payload.");
            }
            break;
        case 'request_state':
            console.log(`Received state request from ${senderId.slice(-4)}`);
            const currentState = captureGameState();
            if (currentState) {
                sendDirectMessage(senderId, { type: 'game_state', payload: currentState });
            } else {
                console.warn("Could not capture local state to send.");
            }
            break;
        case 'request_initial_state':
            // Only host should respond
            if (localPeerId === hostPeerId) {
                console.log(`Received initial state request from ${senderId.slice(-4)}`);
                const initialState = captureGameState();
                if (initialState) {
                    sendDirectMessage(senderId, { type: 'initial_game_state', payload: initialState });
                    console.log(`Sent initial state to ${senderId.slice(-4)}`);
                }
            }
            break;
        case 'initial_game_state':
            console.log(`Received initial game state from host ${senderId.slice(-4)}`);
            if (data.payload) {
                loadGameState(data.payload);
                showStatusUpdate(`Synced with host ${senderId.slice(-4)}.`);
            } else {
                console.warn("Received initial_game_state message without payload.");
            }
            break;
        // Add other message types as needed
        default:
            console.log(`Received unknown message type '${data.type}' from ${senderId.slice(-4)}`);
    }
}

/** Broadcasts data to all connected peers */
function broadcastMessage(message) {
    if (!peer || connections.size === 0) return;
    console.log("Broadcasting message:", message);
    connections.forEach((conn, peerId) => {
        if (conn && conn.open) {
            try {
                conn.send(message);
            } catch (e) {
                console.error(`Error broadcasting to ${peerId}:`, e);
                removeConnection(peerId); // Remove faulty connection
            }
        }
    });
}

/** Sends data directly to a specific peer */
function sendDirectMessage(targetPeerId, message) {
    const conn = connections.get(targetPeerId);
    if (conn && conn.open) {
        try {
            console.log(`Sending direct message to ${targetPeerId}:`, message);
            conn.send(message);
        } catch (e) {
            console.error(`Error sending direct message to ${targetPeerId}:`, e);
            removeConnection(targetPeerId); // Remove faulty connection
        }
    } else {
        console.warn(`Cannot send direct message: No open connection to ${targetPeerId}`);
    }
}

/** Broadcasts the current game state */
function broadcastGameState() {
    if (localPeerId !== hostPeerId) return; // Only host broadcasts state updates implicitly? Or allow all? For now, host only.
    const currentState = captureGameState();
    if (currentState) {
        broadcastMessage({ type: 'game_state', payload: currentState });
    }
}

/** Generates a simple color based on Peer ID */
function getColorForPeerId(peerId) {
    if (!peerId) return '#cccccc'; // Default grey
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) {
        hash = peerId.charCodeAt(i) + ((hash << 5) - hash);
        hash = hash & hash; // Convert to 32bit integer
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 75%)`; // Use HSL for better color distribution
}


/** Updates the player icons in the footer */
function updatePlayerIcons() {
    if (!playerIconsContainer) return;
    playerIconsContainer.innerHTML = ''; // Clear existing icons

    // Add local player icon first
    if (localPeerId) {
        createPlayerIcon(localPeerId, true);
    }

    // Add icons for connected peers
    connections.forEach((conn, peerId) => {
        createPlayerIcon(peerId, false);
    });
}

/** Creates and appends a single player icon */
function createPlayerIcon(peerId, isLocal) {
    if (!playerIconsContainer) return;

    const iconDiv = document.createElement('div');
    iconDiv.className = 'player-icon';
    iconDiv.dataset.peerId = peerId;
    iconDiv.title = peerId; // Show full ID on hover

    // Use part of the peer ID for display (e.g., last 4 chars)
    const initials = peerId.slice(-4);
    const initialsSpan = document.createElement('span');
    initialsSpan.className = 'player-icon-initials';
    initialsSpan.textContent = initials;
    iconDiv.appendChild(initialsSpan);

    // Style based on ID and local/host status
    iconDiv.style.backgroundColor = getColorForPeerId(peerId);
    if (isLocal) {
        iconDiv.classList.add('local-player');
        iconDiv.title += " (You)";
    }
    if (peerId === hostPeerId) {
        iconDiv.classList.add('host-player');
        iconDiv.title += " (Host)";
    }

    // Add click listener
    iconDiv.addEventListener('click', () => handlePlayerIconClick(peerId, isLocal));

    playerIconsContainer.appendChild(iconDiv);
}

/** Handles clicks on player icons */
function handlePlayerIconClick(peerId, isLocal) {
    console.log(`Icon clicked: ${peerId}, isLocal: ${isLocal}`);
    if (isLocal) {
        // Restore local saved state
        if (localGameState) {
            console.log("Restoring local game state...");
            loadGameState(localGameState);
            showStatusUpdate("Restored your saved state.");
        } else {
            console.warn("No local game state saved to restore.");
            showStatusUpdate("No local state saved yet.");
        }
    } else {
        // Request state from remote peer
        console.log(`Requesting state from remote peer: ${peerId}`);
        sendDirectMessage(peerId, { type: 'request_state' });
        showStatusUpdate(`Requesting state from ${peerId.slice(-4)}...`);
    }
}

/** Resets multiplayer state variables and UI */
function resetMultiplayerState() {
    console.warn("Resetting multiplayer state.");
    if (peer && !peer.destroyed) {
        peer.destroy();
    }
    peer = null;
    localPeerId = null;
    hostPeerId = null;
    connections.clear();
    updatePlayerIcons(); // Clear icons
    // Optionally clear status messages related to multiplayer
}

/** Shows a status update message (e.g., in footer or a dedicated div) */
function showStatusUpdate(message) {
    // Simple console log for now, replace with UI update if needed
    console.info(`MP Status: ${message}`);
    // Example: Update clipboard message area temporarily
    showClipboardMessage(message); // Use existing clipboard message area
}


// --- Event Listeners ---

/** Handles the click event for the Submit Turn button. */
submitButton.addEventListener('click', () => {
    console.log("Submit button clicked.");
    // Attempt to initialize/resume audio context on user interaction
    initAudioContext();
    const playerActions = collectInputState();
    if (isLoading) return; // Prevent multiple submissions while loading

    // Call fetchTurnData AFTER collecting current state
    fetchTurnData(playerActions);

    // History queue is updated *before* fetch in fetchTurnData
});

/** Handles input changes in the API Key field. */
apiKeyInput.addEventListener('input', () => {
    const keyPresent = apiKeyInput.value.trim().length > 0;
    // Enable/disable submit button based on key presence (if game not started)
    submitButton.disabled = isLoading || !(apiKeyLocked || keyPresent);
    // Enable/disable reset button similarly - only enabled if game has started *or* key is present but game not started
    resetGameButton.disabled = isLoading || (!apiKeyLocked && !keyPresent);


    // Update initial message if API key section is visible
    if (apiKeySection.style.display !== 'none') {
        const currentInitialMessage = document.getElementById('initial-message');
        if (keyPresent) {
            hideError(); // Hide any previous errors
            if (currentInitialMessage && currentInitialMessage.style.display !== 'none') {
                currentInitialMessage.textContent = 'API Key entered. Click "Submit Turn" to begin your journey!';
            }
        } else {
            // Restore default initial message if key is removed
            if (currentInitialMessage) {
                currentInitialMessage.innerHTML = 'Enter your API Key above (or provide in URL) and click "Submit Turn" to start.<br>Or, paste previously saved game code into your browser console to load a game.';
                currentInitialMessage.style.display = 'block';
            }
        }
    }
});

/** Handles the click event for the Save Game button. */
saveGameButton.addEventListener('click', () => {
    console.log("Save Game button clicked (Manual Save).");
    // Ensure game has started and state exists
    if (!apiKeyLocked || !currentUiJson || !historyQueue) {
        showClipboardMessage("Cannot save: Game not started or state missing.", true);
        return;
    }
    // Ensure API key is present
    const rawApiKey = apiKeyInput.value.trim();
    if (!rawApiKey) {
        showClipboardMessage("Cannot save: API Key is missing.", true);
        return;
    }

    // Get current game URL
    const gameUrl = window.location.origin + window.location.pathname;

    // Prepare state object for manual save (includes URL)
    const stateToSaveForManual = {
        encodedApiKey: encodeApiKey(rawApiKey),
        currentUiJson: currentUiJson,
        historyQueue: historyQueue,
        isMasturbationMode: isMasturbationMode,
        currentModelIndex: currentModelIndex,
        gameUrl: gameUrl // Include URL for potential navigation during restore
    };

    let stateJsonString;
    try {
        stateJsonString = JSON.stringify(stateToSaveForManual);
    } catch (e) {
        console.error("Error stringifying game state for manual saving:", e);
        showClipboardMessage("Error preparing game state for manual saving.", true);
        return;
    }

    // Create the self-executing restoration code to be copied
    const restorationLoaderCode = `
(function() {
    console.log("GEEMS Restoration Loader: Storing state and checking URL...");
    try {
        const stateToStore = ${stateJsonString}; // Embed the saved state JSON
        const storageKey = '${LOCAL_STORAGE_KEY}'; // Use the game's storage key
        const currentGameUrl = window.location.origin + window.location.pathname;

        // Store the state in localStorage
        localStorage.setItem(storageKey, JSON.stringify(stateToStore));
        console.log("Saved state stored in localStorage under key:", storageKey);

        // Check if the current URL matches the saved URL
        if (currentGameUrl !== stateToStore.gameUrl) {
            // If URLs don't match, navigate to the correct URL
            console.log("Current URL (" + currentGameUrl + ") does not match saved URL (" + stateToStore.gameUrl + "). Navigating...");
            alert("GEEMS state saved to browser storage. Navigating to the correct game page to restore..."); // Use alert for user feedback
            window.location.href = stateToStore.gameUrl; // Redirect
        } else {
            // If URLs match, simply reload the page to trigger the restore logic
            console.log("Already on the correct game URL. Reloading page to apply stored state...");
            alert("GEEMS state saved to browser storage. Reloading page to restore..."); // Use alert for user feedback
            window.location.reload(); // Reload
        }

    } catch (error) {
        console.error("Error in GEEMS Restoration Loader:", error);
        alert("Error preparing game state restoration: " + error.message + "\\nCheck the console for more details."); // Use alert for error feedback
        localStorage.removeItem('${LOCAL_STORAGE_KEY}'); // Clear potentially bad state on error
    }
})();
    `;

    // Attempt to copy the restoration code to the clipboard
    navigator.clipboard.writeText(restorationLoaderCode).then(() => {
        console.log("Restoration loader code copied to clipboard.");
        showClipboardMessage("Save code copied! Paste into console to restore."); // Success message
    }).catch(err => {
        // Handle clipboard write failure (e.g., permissions, browser support)
        console.error('Failed to copy restoration loader code: ', err);
        showClipboardMessage("Failed to copy code. See console.", true); // Error message
        // Log the code to the console as a fallback
        console.log("--- GEEMS Save State Loader Code (Copy Manually) ---");
        console.log(restorationLoaderCode);
        console.log("--- End GEEMS Save State Loader Code ---");
        showClipboardMessage("Copy failed. Loader code logged to console.", true); // Update message
    });
});

/** Handles the click event for the Mode Toggle button. */
modeToggleButton.addEventListener('click', () => {
    if (isLoading) return; // Prevent toggling while loading
    isMasturbationMode = !isMasturbationMode; // Flip the mode flag
    console.log(`Masturbation Mode Toggled: ${isMasturbationMode ? 'Explicit' : 'Standard'}`);
    updateModeButtonVisuals(); // Update button appearance
    // Auto-save state when mode changes, as it's a significant state change
    localGameState = captureGameState(); // Update local saved state on mode change too
    autoSaveGameState();
});

/** Handles the click event for the Reset Game button. */
resetGameButton.addEventListener('click', () => {
    // Prevent reset if loading or if reset button is somehow enabled when it shouldn't be
    if (isLoading || resetGameButton.disabled) return;

    // Confirm with the user before resetting
    if (confirm('Are you sure you want to reset the game? All progress will be lost.')) {
        console.log("Resetting game state...");

        // Clear core game state variables
        historyQueue = [];
        currentUiJson = null;
        currentNotes = {};
        currentSubjectId = "";
        localGameState = null; // Clear local saved state
        // Keep isMasturbationMode as it is - Reset button doesn't reset the mode toggle itself
        currentModelIndex = 0; // Reset to first model
        apiKeyLocked = false; // Unlock API key section visibility logic

        // Clear game state from localStorage
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        console.log("Cleared game state from localStorage.");

        // Reset multiplayer
        resetMultiplayerState();

        // Reset UI and errors
        uiContainer.innerHTML = ''; // Clear game elements
        hideError(); // Hide any existing errors

        // Show API key section again
        if (apiKeySection) apiKeySection.style.display = 'block';

        // Re-add initial message
        let currentInitialMessage = document.getElementById('initial-message');
        if (!currentInitialMessage) {
            // If it was removed entirely, recreate it
            currentInitialMessage = document.createElement('div');
            currentInitialMessage.id = 'initial-message';
            currentInitialMessage.className = 'text-center text-gray-500 p-6 bg-white rounded-lg shadow';
            uiContainer.appendChild(currentInitialMessage);
        }
        currentInitialMessage.style.display = 'block'; // Ensure it's visible
        currentInitialMessage.innerHTML = 'Enter your API Key above (or provide in URL) and click "Submit Turn" to start.<br>Or, paste previously saved game code into your browser console to load a game.';


        // Update button states for reset state (API key still present)
        const keyPresent = apiKeyInput.value.trim().length > 0;
        setLoading(false); // Make sure loading is false
        submitButton.disabled = !keyPresent; // Enable submit only if key is still there
        saveGameButton.disabled = true; // Disable save until game starts
        resetGameButton.disabled = !keyPresent; // Disable reset if key was cleared somehow
        modeToggleButton.disabled = false; // Mode toggle still functional
        updateModeButtonVisuals(); // Reflect current mode
    }
});


// --- Initial Game Setup ---

/** Initializes the game state. Checks localStorage, then URL param, then sets up for manual start. */
function initializeGame() {
    console.log("Initializing GEEMS interface...");
    let autoStarted = false; // Flag to track if game loaded automatically

    // --- Priority 1: Load from localStorage (Auto-saved or Manually restored state) ---
    const storedStateString = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (storedStateString) {
        console.log("Found saved state in localStorage. Attempting restore...");
        let savedState;
        try {
            savedState = JSON.parse(storedStateString);
            // State is NOT removed from localStorage here. It persists until reset or error.

            // Decode API key
            const decodedApiKey = decodeApiKey(savedState.encodedApiKey);
            if (!decodedApiKey) {
                throw new Error("Failed to decode API key from saved state.");
            }

            // Restore game state variables
            apiKeyInput.value = decodedApiKey;
            historyQueue = savedState.historyQueue || [];
            currentUiJson = savedState.currentUiJson || null;
            isMasturbationMode = savedState.isMasturbationMode === true; // Explicitly check for true
            currentModelIndex = savedState.currentModelIndex || 0;
            apiKeyLocked = true; // Assume key is locked if state is restored


            // Restore hidden fields from the loaded UI if available
            if (currentUiJson && Array.isArray(currentUiJson)) {
                currentUiJson.forEach(el => {
                    if (el.type === 'hidden') {
                        if (el.name === 'notes') currentNotes = el.value || null;
                        if (el.name === 'subjectId') currentSubjectId = el.value || "";
                    }
                });
            }

            // Capture the restored state as the initial local state
            localGameState = captureGameState();
            autoStarted = true; // Mark as auto-started

            console.log("State restored from localStorage:", {
                historyLength: historyQueue.length,
                mode: isMasturbationMode,
                modelIndex: currentModelIndex,
                subjectId: currentSubjectId // Log restored subjectId
            });


            setDynamicImages(); // Set header/footer images

            // Render the restored UI if it exists
            if (currentUiJson) {
                renderUI(currentUiJson);
                // Initialize multiplayer now that API key is confirmed and game is starting
                initializeMultiplayer();
            } else {
                // If UI data is missing, treat as error, clear storage, force manual start
                console.warn("Restored state missing UI data. Clearing storage and forcing manual start.");
                localStorage.removeItem(LOCAL_STORAGE_KEY); // Clear bad state
                throw new Error("Restored state was incomplete (missing UI)."); // Trigger catch block
            }

            // Update UI elements post-restore
            updateModeButtonVisuals();
            apiKeySection.style.display = 'none'; // Hide API key section
            const currentInitialMessage = document.getElementById('initial-message');
            if (currentInitialMessage) currentInitialMessage.style.display = 'none'; // Hide initial message
            hideError(); // Clear any previous errors
            setLoading(false); // Ensure loading indicator is off and buttons are correctly enabled/disabled

            // No need to explicitly call setLoading(false) for buttons here,
            // as setLoading(false) handles the logic based on apiKeyLocked=true

        } catch (error) {
            // Handle errors during restore
            console.error("Error restoring state from localStorage:", error);
            showError(`Error restoring saved state: ${error.message}. Please start manually.`);
            localStorage.removeItem(LOCAL_STORAGE_KEY); // Clear corrupted/incomplete state

            // Reset state variables to ensure a clean manual start
            historyQueue = [];
            currentUiJson = null;
            currentNotes = {};
            currentSubjectId = "";
            localGameState = null;
            isMasturbationMode = false; // Reset mode on failed restore
            currentModelIndex = 0;
            apiKeyLocked = false;
            autoStarted = false; // Ensure manual start proceeds
            apiKeyInput.value = ''; // Clear API key field

            // Reset UI for manual start
            uiContainer.innerHTML = ''; // Clear potentially broken UI
            const initialMsg = document.getElementById('initial-message') || createInitialMessage(); // Ensure initial message exists
            initialMsg.style.display = 'block'; // Show initial message
            initialMsg.innerHTML = 'Error restoring state. Enter your API Key above (or provide in URL) and click "Submit Turn" to start.<br>Or, paste previously saved game code into your browser console to load a game.';

            if (apiKeySection) apiKeySection.style.display = 'block'; // Show API key section
            setLoading(false); // Set button states for manual start
            setDynamicImages(); // Set default images
        }
    }

    // --- Priority 2: Load from 'apiKey' URL parameter (only if not loaded from storage) ---
    if (!autoStarted) {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const keyFromUrlParam = urlParams.get('apiKey');

            if (keyFromUrlParam) {
                console.log("API Key found in URL parameter. Attempting auto-start...");
                apiKeyInput.value = keyFromUrlParam; // Set API key from URL
                apiKeyLocked = false; // Key is present but not locked until first fetch succeeds
                // Reset other state variables for a fresh start
                currentModelIndex = 0;
                isMasturbationMode = false; // Start with default mode on URL load
                historyQueue = [];
                currentUiJson = null;
                currentNotes = {};
                currentSubjectId = "";
                localGameState = null;


                // Update UI for auto-start
                apiKeySection.style.display = 'none'; // Hide API key section
                const currentInitialMessage = document.getElementById('initial-message') || createInitialMessage();
                currentInitialMessage.style.display = 'none'; // Hide initial message

                // Clean the API key from the URL bar for security/cleanliness
                const currentUrl = new URL(window.location.href);
                currentUrl.searchParams.delete('apiKey');
                window.history.replaceState(null, '', currentUrl.toString()); // Update URL without reloading

                setDynamicImages(); // Set header/footer images

                // Fetch the first turn using the provided key
                // Pass empty JSON "{}" as player actions for the first turn fetch
                fetchTurnData("{}"); // This will set apiKeyLocked=true and call initializeMultiplayer on success
                autoStarted = true; // Mark as auto-started

                // Set initial button states after initiating fetch
                setLoading(true); // Fetch starts in loading state
                updateModeButtonVisuals();
                modeToggleButton.disabled = true; // Disable during initial load
                saveGameButton.disabled = true;
                resetGameButton.disabled = true;


            }
        } catch (e) {
            console.error("Error processing URL parameters:", e);
            showError("Error reading URL parameters. Please start manually.");
            autoStarted = false; // Ensure manual start proceeds if URL processing fails
        }
    }

    // --- Manual Start Setup (if not auto-started from storage or URL) ---
    if (!autoStarted) {
        console.log("Manual start required. Enter API Key or paste save code into console.");
        // Ensure state variables are reset for a clean manual start
        historyQueue = [];
        currentUiJson = null;
        currentNotes = {};
        currentSubjectId = "";
        localGameState = null;
        isMasturbationMode = false; // Ensure default mode for clean manual start
        currentModelIndex = 0;
        apiKeyLocked = false;
        uiContainer.innerHTML = ''; // Clear UI container

        // Ensure initial message is displayed correctly
        const currentInitialMessage = document.getElementById('initial-message') || createInitialMessage();
        currentInitialMessage.style.display = 'block'; // Make sure it's visible
        currentInitialMessage.innerHTML = 'Enter your API Key above (or provide in URL) and click "Submit Turn" to start.<br>Or, paste previously saved game code into your browser console to load a game.';

        // Ensure API key section is visible and input is clear
        if (apiKeySection) apiKeySection.style.display = 'block';
        apiKeyInput.value = '';

        // Set initial button states for manual start
        setLoading(false); // Handles button disabling based on loading=false and apiKeyLocked=false
        hideError(); // Clear any previous errors
        updateModeButtonVisuals(); // Set initial mode button text
        setDynamicImages(); // Set header/footer images
    }
}

// Helper to create initial message if missing
function createInitialMessage() {
    const msgDiv = document.createElement('div');
    msgDiv.id = 'initial-message';
    msgDiv.className = 'text-center text-gray-500 p-6 bg-white rounded-lg shadow';
    // Insert before the loading indicator if possible, otherwise append
    if (loadingIndicator && loadingIndicator.parentNode === uiContainer.parentNode) {
        uiContainer.parentNode.insertBefore(msgDiv, loadingIndicator);
    } else {
        uiContainer.appendChild(msgDiv);
    }
    return msgDiv;
}


// --- Initialize ---
// Call the initialization function when the script loads
initializeGame();