// Import prompts from the separate file (if still needed for single-player)
import {geemsPrompts} from './prompts.js';
import MPLib from './mp.js';
// Assuming MPLib is globally available after including mp.js or imported if using modules
// import MPLib from './mp.js'; // Uncomment if using ES6 modules for MPLib

// --- Game State Variables ---
let historyQueue = [];
const MAX_HISTORY_SIZE = 20;
let currentUiJson = null;
let currentNotes = {};
let currentSubjectId = "";
let isMasturbationMode = false; // Default mode
let isLoading = false;
let apiKeyLocked = false;
let localGameStateSnapshot = null; // To store local state when viewing remote state
let hiddenAnalysisContent = null; // To store content of gemini_facing_analysis for modal
let hiddenAnalysisContentTweet = null; // To store content of gemini_facing_analysis for modal
let hiddenAnalysisContentNotes = null; // To store content of gemini_facing_analysis for modal

// --- Model Switching State ---
const AVAILABLE_MODELS = ["gemini-2.5-pro-exp-03-25",
    "gemini-2.0-pro-exp-02-05",
    "gemini-1.5-pro",
    "gemini-2.0-flash-exp",
    "gemini-exp-1206"];
let currentModelIndex = 0;

// --- Configuration ---
const MIN_CONTRAST_LIGHTNESS = 0.55;
const LOCAL_STORAGE_KEY = 'geemsGameStateToRestore';
const DEFAULT_HOST_ID = 'geems-default-game-host'; // Define a host ID for players to connect to

// --- DOM Element References ---
const uiContainer = document.getElementById('ui-elements');
const loadingIndicator = document.getElementById('loading');
const submitButton = document.getElementById('submit-turn');
const apiKeyInput = document.getElementById('apiKeyInput');
const apiKeySection = document.getElementById('apiKeySection');
const errorDisplay = document.getElementById('error-display');
const modeToggleButton = document.getElementById('modeToggleButton');
const resetGameButton = document.getElementById('resetGameButton');
const clipboardMessage = document.getElementById('clipboardMessage');
const headerBanner = document.getElementById('headerBanner');
const footerBanner = document.getElementById('footerBanner');
// Assume footer exists, get reference to it
const footerElement = document.querySelector('.site-footer');
const h1 = document.querySelector('h1');
let peerListContainer = null; // Will be created dynamically
// Add references for the modal (assuming HTML structure exists)
const analysisModal = document.getElementById('analysisModal'); // e.g., <div id="analysisModal" class="modal" style="display:none;">...</div>
const analysisModalBody = document.getElementById('analysisModalBody'); // e.g., <div id="analysisModalBody"></div> inside the modal
const analysisModalClose = document.getElementById('analysisModalClose'); // e.g., <button id="analysisModalClose">Close</button> inside the modal

// --- Web Audio API Context ---
let audioCtx = null;

// --- Multiplayer State ---
const remoteGameStates = new Map(); // Map<peerId, gameState>

// --- Long Press State ---
let pressTimer = null;
let isLongPress = false;
const longPressDuration = 750; // milliseconds

// --- Helper Functions ---

/** Encodes a string using Base64. */
function encodeApiKey(key) {
    try {
        return btoa(key);
    } catch (e) {
        console.error("Error encoding API key:", e);
        return "";
    }
}

/** Decodes a Base64 string. Returns null on error. */
function decodeApiKey(encodedKey) {
    try {
        return atob(encodedKey);
    } catch (e) {
        console.error("Error decoding API key:", e);
        return null;
    }
}
/** Constructs the full prompt for the Gemini API call. */
function constructPrompt(playerActionsJson, historyQueue, isMasturbationMode) {
    const baseMainPrompt = geemsPrompts.main;
    const activeAddendum = isMasturbationMode ? `\n\n---\n${geemsPrompts.masturbationModeAddendum}\n---\n` : "";
    if (historyQueue.length === 0) {
        const s = `${geemsPrompts.firstrun}\n\n---\n${baseMainPrompt}${activeAddendum}\n---\n${geemsPrompts.exampleTurn}\n---\n\n--- Generate JSON UI for Turn 1 ---`;
        console.log("Generated T1 Prompt Snippet:", s.substring(0, 200) + "...");
        return s;
    } else {
        const historyString = historyQueue.map(item => `UI:\n${item.ui}\nActions:\n${item.actions}`).join('\n---\n');
        const s = `${baseMainPrompt}${activeAddendum}\n\n--- Last Player Actions ---\n${playerActionsJson}\n\n--- Prior Game History (Last ${historyQueue.length} turns) ---\n${historyString}\n\n--- Generate Next Game Turn JSON UI ARRAY ---`;
        console.log("Generated Subsequent Turn Prompt Snippet:", s.substring(0, 200) + "...");
        return s;
    }
}

/** Saves the current essential game state to local storage. */
function autoSaveGameState() {
    if (!apiKeyLocked) return;
    if (!currentUiJson || !historyQueue) return;
    const rawApiKey = apiKeyInput.value.trim();
    if (!rawApiKey) return;
    try {
        const stateToSave = {
            encodedApiKey: encodeApiKey(rawApiKey),
            currentUiJson: currentUiJson,
            historyQueue: historyQueue,
            isMasturbationMode: isMasturbationMode,
            currentModelIndex: currentModelIndex
        };
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stateToSave));
        console.log("Game state auto-saved.");
    } catch (error) {
        console.error("Error during auto-save:", error);
        showError("Error auto-saving game state.");
    }
}

/** Initializes the AudioContext if it doesn't exist. */
function initAudioContext() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log("AudioContext initialized.");
            if (audioCtx.state === 'suspended') audioCtx.resume();
        } catch (e) {
            console.error("Web Audio API not supported.", e);
            showError("Audio alerts not supported.");
        }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(err => console.error("Error resuming audio context:", err));
}

/** Plays the turn alert sound. */
function playTurnAlertSound() {
    initAudioContext();
    if (!audioCtx || audioCtx.state !== 'running') return;
    const now = audioCtx.currentTime, totalDuration = 1.0;
    const fogOsc = audioCtx.createOscillator(), fogGain = audioCtx.createGain();
    fogOsc.type = 'sawtooth';
    fogOsc.frequency.setValueAtTime(80, now);
    fogGain.gain.setValueAtTime(0.3, now);
    fogGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    fogOsc.connect(fogGain);
    fogGain.connect(audioCtx.destination);
    fogOsc.start(now);
    fogOsc.stop(now + 0.5);
    const beepOsc = audioCtx.createOscillator(), beepGain = audioCtx.createGain();
    beepOsc.type = 'square';
    beepOsc.frequency.setValueAtTime(440, now + 0.6);
    beepGain.gain.setValueAtTime(0, now + 0.6);
    beepGain.gain.linearRampToValueAtTime(0.2, now + 0.65);
    beepGain.gain.setValueAtTime(0.2, now + 0.75);
    beepGain.gain.linearRampToValueAtTime(0, now + 0.8);
    beepOsc.frequency.setValueAtTime(523, now + 0.85);
    beepGain.gain.setValueAtTime(0, now + 0.85);
    beepGain.gain.linearRampToValueAtTime(0.2, now + 0.9);
    beepGain.gain.setValueAtTime(0.2, now + totalDuration - 0.05);
    beepGain.gain.linearRampToValueAtTime(0.001, now + totalDuration);
    beepOsc.connect(beepGain);
    beepGain.connect(audioCtx.destination);
    beepOsc.start(now + 0.6);
    beepOsc.stop(now + totalDuration);
    console.log("Playing turn alert sound.");
}

/** Updates the history queue. */
function updateHistoryQueue(playerActionsJson) {
    if (currentUiJson) {
        const previousTurnData = {ui: JSON.stringify(currentUiJson), actions: playerActionsJson || "{}"};
        const isDuplicate = historyQueue.some(item => JSON.stringify(item) === JSON.stringify(previousTurnData));
        if (isDuplicate) {
            console.log("Duplicate turn data detected, not adding to history queue.");
            return;
        }
        if (historyQueue.length >= MAX_HISTORY_SIZE) historyQueue.shift();
        historyQueue.push(previousTurnData);
        console.log(`History Queue size: ${historyQueue.length}/${MAX_HISTORY_SIZE}`);
    }
}

/** Gets the current game state for sending to peers. */
function getCurrentGameState() {
    // Basic example: Send current UI JSON and history.
    // Adapt this to include *actual* relevant game variables.
    return {
        currentUiJson: currentUiJson,
        historyQueue: historyQueue,
        currentSubjectId: currentSubjectId,
        // Add other critical state variables here, e.g., player inventory, world state etc.
        // currentNotes: currentNotes // Maybe too large? Decide what's needed.
    };
}

/** Loads a game state received from a peer. */
function loadGameState(newState, sourcePeerId = null) {
    if (!newState) {
        console.error("Attempted to load null game state.");
        return;
    }
    console.log(`Loading game state${sourcePeerId ? ` from peer ${sourcePeerId.slice(-6)}` : ''}`);

    // Before loading remote state, save the current local state
    saveLocalState();

    // Basic example: Restore UI and history.
    // Adapt this to handle your game's specific state restoration.
    currentUiJson = newState.currentUiJson || null;
    historyQueue = newState.historyQueue || [];
    currentSubjectId = newState.currentSubjectId || "Peer"; // Maybe use peer's subject ID?

    // Render the loaded UI
    if (currentUiJson) {
        renderUI(currentUiJson);
        console.log("Loaded game state UI rendered.");
        // Disable submit turn button when viewing remote state?
        submitButton.disabled = false; // Disable submit when viewing remote state
        showNotification(`Viewing ${sourcePeerId ? sourcePeerId.slice(-6) : 'remote'} state. Click your icon to return.`, 'info', 5000);
    } else {
        showError("Loaded game state is missing UI data.");
    }
    updatePeerListUI(); // Highlight the peer being viewed
    highlightPeerIcon(sourcePeerId); // Explicitly highlight
}

/** Saves the current local game state snapshot. */
function saveLocalState() {
    console.log("Saving local game state snapshot.");
    localGameStateSnapshot = {
        currentUiJson: JSON.parse(JSON.stringify(currentUiJson)), // Deep copy
        historyQueue: JSON.parse(JSON.stringify(historyQueue)),   // Deep copy
        currentSubjectId: currentSubjectId
    };
}

/** Restores the previously saved local game state. */
function restoreLocalState() {
    if (localGameStateSnapshot) {
        console.log("Restoring local game state.");
        currentUiJson = localGameStateSnapshot.currentUiJson;
        historyQueue = localGameStateSnapshot.historyQueue;
        currentSubjectId = localGameStateSnapshot.currentSubjectId;
        localGameStateSnapshot = null; // Clear the snapshot

        if (currentUiJson) {
            renderUI(currentUiJson);
            console.log("Restored local game state UI rendered.");
            submitButton.disabled = isLoading || !apiKeyLocked; // Re-enable submit button
            updatePeerListUI(); // Clear highlights
            showNotification("Returned to your game state.", "info", 2000);
        } else {
            showError("Error restoring local game state: UI data missing.");
            // Might need a more robust recovery here
        }
    } else {
        console.warn("No local game state snapshot to restore.");
    }
}


/** Processes the successful response from the Gemini API. */
function processSuccessfulResponse(responseJson, playerActionsJson) {
    currentUiJson = responseJson;
    if (!apiKeyLocked) {
        apiKeyLocked = true;
        if (apiKeySection) apiKeySection.style.display = 'none';
        resetGameButton.disabled = false;
    }
    renderUI(currentUiJson); // This will also populate hiddenAnalysisContent if present
    playTurnAlertSound();
    autoSaveGameState();

    // Broadcast the new state to peers after processing locally
    broadcastGameState();
}

/** Broadcasts the current game state to all connected peers */
function broadcastGameState() {
    if (!MPLib || MPLib.getConnections().size === 0) return; // Check if MPLib is available and peers connected

    const stateToSend = getCurrentGameState();
    console.log("Broadcasting game state update to peers.");
    MPLib.broadcast({
        type: 'game_state_update',
        payload: stateToSend
    });
}

/** Fetches the next turn's UI data from the Gemini API. */
async function fetchTurnData(playerActionsJson) {
    
    // Update history queue with the player actions JSON for the current turn.
    updateHistoryQueue(playerActionsJson); // Update history. Clear flag upon successful response from Gemini.
    console.log("fetchTurnData called.");
    initAudioContext();
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showError("Please enter API Key");
        setLoading(false);
        if (apiKeySection.style.display === 'none') apiKeySection.style.display = 'block';
        return;
    }

    setLoading(true);
    hideError();
    const initialMsgEl = document.getElementById('initial-message');
    if (initialMsgEl) initialMsgEl.style.display = 'none';

    let success = false;
    let attempts = 0;
    const maxAttempts = AVAILABLE_MODELS.length * 2 + 1;
    let currentAttemptConsecutiveErrors = 0;

    while (!success && attempts < maxAttempts) {
        attempts++;
        const currentModel = AVAILABLE_MODELS[currentModelIndex];
        console.log(`Attempt ${attempts}/${maxAttempts}: Trying model ${currentModel}`);
        try {
            const fullPrompt = constructPrompt(playerActionsJson, historyQueue, isMasturbationMode);
            console.log(`Sending Prompt to ${currentModel}`);
            const jsonStringResponse = await callRealGeminiAPI(apiKey, fullPrompt, currentModel);
            const responseJson = JSON.parse(jsonStringResponse);
            console.log(`Parsed API response from ${currentModel}.`);
            processSuccessfulResponse(responseJson, playerActionsJson); // Pass actions that led to this response
            success = true;
            currentAttemptConsecutiveErrors = 0;
        } catch (error) {
            console.error(`Error with model ${currentModel} (Attempt ${attempts}):`, error);
            currentAttemptConsecutiveErrors++;
            const isQuotaError = error.message.includes('429') || /quota exceeded|resource.*exhausted/i.test(error.message);
            const shouldSwitch = isQuotaError || currentAttemptConsecutiveErrors >= 2;
            if (shouldSwitch && AVAILABLE_MODELS.length > 1) {
                const oldModel = AVAILABLE_MODELS[currentModelIndex];
                currentModelIndex = (currentModelIndex + 1) % AVAILABLE_MODELS.length;
                const newModel = AVAILABLE_MODELS[currentModelIndex];
                console.warn(`Switching model from ${oldModel} to ${newModel} due to ${isQuotaError ? 'quota/resource error' : '2 errors'}.`);
                showError(`Experiencing issues with ${oldModel}. Trying ${newModel}... (Attempt ${attempts + 1})`);
                currentAttemptConsecutiveErrors = 0;
            } else if (attempts < maxAttempts) {
                showError(`Temporary issue with ${currentModel}. Retrying... (Attempt ${attempts + 1})`);
            }
            if (!success && attempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, 750));
        }
    }
    if (!success) {
        console.error(`Failed after ${maxAttempts} attempts.`);
        showError(`Failed to get response after ${maxAttempts} attempts. Check API key, network, or try later.`);
    } else {
        hideError();
        window.scrollTo({top: 0, behavior: 'smooth'});
    }
    setLoading(false);
}

/** Calls the real Google AI (Gemini) API. */
async function callRealGeminiAPI(apiKey, promptText, modelName) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const requestBody = {
        contents: [{parts: [{text: promptText}]}],
        generationConfig: {temperature: 1.0, response_mime_type: "application/json"},
        safetySettings: [{
            "category": "HARM_CATEGORY_HARASSMENT",
            "threshold": "BLOCK_NONE"
        }, {
            "category": "HARM_CATEGORY_HATE_SPEECH",
            "threshold": "BLOCK_NONE"
        }, {
            "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            "threshold": "BLOCK_NONE"
        }, {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}]
    };
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
        let errorBody = `API request failed (${response.status})`;
        try {
            const errorJson = await response.json();
            errorBody += `: ${JSON.stringify(errorJson.error || errorJson)}`;
        } catch (e) {
            try {
                errorBody += `: ${await response.text()}`;
            } catch (e2) {
            }
        }
        console.error("API Error:", errorBody);
        throw new Error(errorBody);
    }
    const responseData = await response.json();
    if (responseData.promptFeedback && responseData.promptFeedback.blockReason) throw new Error(`Request blocked by API. Reason: ${responseData.promptFeedback.blockReason}. Details: ${JSON.stringify(responseData.promptFeedback.safetyRatings || 'N/A')}`);
    if (!responseData.candidates || responseData.candidates.length === 0) {
        if (typeof responseData === 'string') {
            try {
                JSON.parse(responseData);
                return responseData.trim();
            } catch (e) {
                throw new Error('No candidates, response not valid JSON.');
            }
        }
        throw new Error('No candidates or unexpected API response.');
    }
    const candidate = responseData.candidates[0];
    if (candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
        if (candidate.finishReason === "SAFETY") throw new Error(`API call finished due to SAFETY. Ratings: ${JSON.stringify(candidate.safetyRatings || 'N/A')}`); else if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) throw new Error(`API call finished unexpectedly (${candidate.finishReason}) and no content.`);
    }
    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        let generatedText = candidate.content.parts[0].text;
        const jsonMatch = generatedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) generatedText = jsonMatch[1];
        let trimmedText = generatedText.trim();
        try {
            JSON.parse(trimmedText);
            return trimmedText;
        } catch (e) {
            throw new Error(`Invalid JSON from API. Snippet: ${trimmedText.substring(0, 200)}...`);
        }
    } else throw new Error('API candidate generated but no content parts.');
}

/** Renders the UI elements based on the JSON array. */
function renderUI(uiJsonArray) {
    console.log("renderUI started.");
    hiddenAnalysisContent = null; // Reset hidden content before rendering new UI
    const initialMsgElementRef = document.getElementById('initial-message');
    uiContainer.innerHTML = '';
    if (!Array.isArray(uiJsonArray)) {
        console.error("Invalid UI data: Expected an array.", uiJsonArray);
        showError("Invalid UI data format from API.");
        if (initialMsgElementRef) {
            const clonedInitialMsg = initialMsgElementRef.cloneNode(true);
            clonedInitialMsg.style.display = 'block';
            uiContainer.appendChild(clonedInitialMsg);
        }
        return;
    }
    uiJsonArray.forEach((element, index) => {
        renderSingleElement(element, index);
    });
    const imageElement = uiContainer.querySelector('.geems-image-container');
    const analysisToggleContainer = uiContainer.querySelector('.analysis-toggle-container');
    if (imageElement && analysisToggleContainer) {
        uiContainer.insertBefore(analysisToggleContainer, imageElement.nextSibling || null);
    }
    const tweetElement = document.getElementById('tweet-element-wrapper');
    if (analysisToggleContainer && tweetElement) {
        uiContainer.insertBefore(tweetElement, analysisToggleContainer.nextSibling || null);
    } else if (imageElement && tweetElement) {
        uiContainer.insertBefore(tweetElement, imageElement.nextSibling || null);
    }
}

/** Renders a single UI element. */
function renderSingleElement(element, index) {
    // --- MODIFICATION START: Check for gemini_facing_analysis ---
    // If it's the gemini_facing_analysis text element, store its content and skip rendering.
    if (element.type === 'text' && element.name?.includes('gemini_facing_analysis')) {
        hiddenAnalysisContent = element.text || element.value || '';
        console.log("Stored hidden 'gemini_facing_analysis' content.");
        return; // Do not render this element to the main UI
    }
    if (element.name?.includes('tweet')) {
        hiddenAnalysisContentTweet = element.text || element.value || '';
        console.log("Stored hidden 'tweet' content.");
        return; // Do not render this element to the main UI
    }
    if (element.name?.includes('notes')) {
        hiddenAnalysisContentNotes = element.value || '';
        console.log("Stored hidden 'gemini_facing_analysis' content.");
        return; // Do not render this element to the main UI
    }
    // --- MODIFICATION END ---

    const wrapper = document.createElement('div');
    wrapper.className = 'geems-element';
    if (element.voice) wrapper.classList.add(`voice-${element.voice}`);
    let adjustedColor = null;
    if (element.color && isValidHexColor(element.color)) {
        adjustedColor = adjustColorForContrast(element.color);
        wrapper.style.borderLeftColor = adjustedColor;
        if (wrapper.classList.contains('analysis-toggle-container')) wrapper.style.borderColor = adjustedColor;
    } else {
        wrapper.style.borderLeftColor = 'transparent';
    }
    try {
        switch (element.type) {
            case 'image':
                renderImage(wrapper, element, adjustedColor);
                break;
            case 'text':
                renderText(wrapper, element, adjustedColor);
                break; // Will be skipped for gemini_facing_analysis by the check above
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
            case 'hidden':
                if (element.name === 'notes') currentNotes = element.value || null; else if (element.name === 'subjectId') currentSubjectId = element.value || "";
                return;
            default:
                console.warn("Unknown element type:", element.type, element);
                wrapper.textContent = `Unknown element type: ${element.type}`;
                wrapper.style.color = 'red';
        }
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
function renderImage(wrapper, element, adjustedColor) {
    wrapper.classList.add('geems-image-container');
    wrapper.classList.remove('geems-element');
    wrapper.style.borderLeftColor = 'transparent';
    const img = document.createElement('img');
    img.className = 'geems-image';
    const imagePrompt = element.value || 'abstract image';
    const randomSeed = Math.floor(Math.random() * 65536);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?nologo=true&safe=false&seed=${randomSeed}`;
    img.src = imageUrl;
    img.alt = element.label || `Image: ${imagePrompt.substring(0, 50)}...`;
    img.onerror = () => {
        console.warn(`Failed to load image: ${imageUrl}`);
        img.src = `https://placehold.co/600x400/e0e7ff/4f46e5?text=Image+Load+Error`;
        img.alt = `Error loading image: ${imagePrompt.substring(0, 50)}...`;
    };
    wrapper.appendChild(img);
    if (element.label) {
        const labelDiv = document.createElement('div');
        labelDiv.className = 'geems-label text-center font-semibold mt-2';
        if (adjustedColor) labelDiv.style.color = adjustedColor;
        labelDiv.textContent = element.label;
        wrapper.appendChild(labelDiv);
    }
    const promptText = document.createElement('p');
    promptText.className = 'geems-image-prompt';
    promptText.textContent = imagePrompt;
    wrapper.appendChild(promptText);
}

function renderText(wrapper, element, adjustedColor) {
    const textContent = element.text || element.value || '';
    const useLabel = element.label && !['narrative', 'divine_wisdom', 'player_facing_analysis'].some(namePart => element.name?.includes(namePart)); /* Removed gemini_facing_analysis from here as it's handled earlier */
    if (useLabel) {
        const label = document.createElement('label');
        label.className = 'geems-label';
        if (adjustedColor) label.style.color = adjustedColor;
        label.textContent = element.label;
        wrapper.appendChild(label);
    }
    const textElement = document.createElement('div');
    textElement.className = 'geems-text';
    textElement.innerHTML = textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/```([\s\S]*?)```/g, (match, p1) => `<pre>${p1.trim()}</pre>`).replace(/\n/g, '<br>');
    wrapper.appendChild(textElement);
}

function renderTextField(wrapper, element, adjustedColor) {
    const label = document.createElement('label');
    label.className = 'geems-label';
    label.textContent = element.label || element.name;
    label.htmlFor = element.name;
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);
    const input = document.createElement('textarea');
    input.className = 'geems-textarea';
    input.id = element.name;
    input.name = element.name;
    input.rows = 4;
    input.value = element.value || '';
    input.placeholder = element.placeholder || 'Type response...';
    input.dataset.elementType = 'textfield';
    wrapper.appendChild(input);
}

function renderCheckbox(wrapper, element, adjustedColor) {
    wrapper.classList.remove('geems-element');
    wrapper.style.borderLeftColor = 'transparent';
    wrapper.style.padding = '0';
    wrapper.style.marginBottom = '0.75rem';
    const optionDiv = document.createElement('div');
    optionDiv.className = 'geems-checkbox-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = element.name;
    input.name = element.name;
    input.checked = element.value === true || String(element.value).toLowerCase() === 'true';
    input.dataset.elementType = 'checkbox';
    if (adjustedColor) input.style.accentColor = adjustedColor;
    const label = document.createElement('label');
    label.htmlFor = element.name;
    label.textContent = element.label || element.name;
    label.className = "flex-grow cursor-pointer";
    optionDiv.appendChild(input);
    optionDiv.appendChild(label);
    wrapper.appendChild(optionDiv);
}

function renderSlider(wrapper, element, adjustedColor) {
    const label = document.createElement('label');
    label.className = 'geems-label';
    label.textContent = element.label || element.name;
    label.htmlFor = element.name;
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);
    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'flex items-center space-x-4 mt-2';
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'geems-slider flex-grow';
    input.id = element.name;
    input.name = element.name;
    const min = parseFloat(element.min) || 0;
    const max = parseFloat(element.max) || 10;
    input.min = min;
    input.max = max;
    input.step = element.step || 1;
    const defaultValue = parseFloat(element.value);
    input.value = isNaN(defaultValue) ? (min + max) / 2 : Math.max(min, Math.min(max, defaultValue));
    input.dataset.elementType = 'slider';
    if (adjustedColor) {
        input.style.accentColor = adjustedColor;
        input.style.setProperty('--slider-thumb-color', adjustedColor);
        input.setAttribute('style', `${input.getAttribute('style') || ''} --slider-thumb-color: ${adjustedColor};`);
    }
    const valueDisplay = document.createElement('span');
    valueDisplay.className = `geems-slider-value-display font-medium w-auto text-right`;
    valueDisplay.textContent = input.value;
    if (adjustedColor) valueDisplay.style.color = adjustedColor;
    input.oninput = () => {
        valueDisplay.textContent = input.value;
    };
    sliderContainer.appendChild(input);
    sliderContainer.appendChild(valueDisplay);
    wrapper.appendChild(sliderContainer);
}

function renderRadio(wrapper, element, adjustedColor) {
    wrapper.classList.remove('geems-element');
    wrapper.style.borderLeftColor = 'transparent';
    wrapper.style.padding = '0';
    wrapper.style.marginBottom = '0.75rem';
    const label = document.createElement('label');
    label.className = 'geems-label block mb-2';
    label.textContent = element.label || element.name;
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);
    let options = [];
    let defaultValue = null;
    let optionsSource = element.options || element.value;
    try {
        if (typeof optionsSource === 'string') {
            try {
                optionsSource = JSON.parse(optionsSource);
            } catch (e) {
                optionsSource = [{label: optionsSource, value: optionsSource}];
            }
        }
        if (Array.isArray(optionsSource)) {
            options = optionsSource.map(opt => {
                let currentLabel = '', currentValue = '', isDefault = false;
                if (typeof opt === 'object' && opt !== null && opt.value !== undefined) {
                    currentValue = String(opt.value);
                    currentLabel = opt.label !== undefined ? String(opt.label) : currentValue;
                    if (currentLabel.startsWith('*')) {
                        defaultValue = currentValue;
                        currentLabel = currentLabel.substring(1);
                        isDefault = true;
                    }
                } else {
                    currentValue = String(opt);
                    currentLabel = currentValue;
                    if (currentLabel.startsWith('*')) {
                        defaultValue = currentValue.substring(1);
                        currentValue = defaultValue;
                        currentLabel = defaultValue;
                        isDefault = true;
                    }
                }
                return {value: currentValue, label: currentLabel, isDefault: isDefault};
            }).filter(opt => opt !== null);
            if (defaultValue === null && element.value && typeof element.value === 'string') {
                let isValueSimpleString = true;
                try {
                    if (Array.isArray(JSON.parse(element.value))) isValueSimpleString = false;
                } catch (e) {
                }
                if (isValueSimpleString) {
                    const directValueMatch = options.find(opt => opt.value === element.value);
                    if (directValueMatch) defaultValue = directValueMatch.value;
                }
            }
        }
    } catch (e) {
        console.error("Failed radio options:", element.name, e);
    }
    if (defaultValue === null && options.length > 0) defaultValue = options[0].value;
    if (options.length > 0) {
        options.forEach((option, index) => {
            const optionDiv = document.createElement('div');
            optionDiv.className = 'geems-radio-option';
            const input = document.createElement('input');
            input.type = 'radio';
            const inputId = `${element.name}_${index}`;
            input.id = inputId;
            input.name = element.name;
            input.value = option.value;
            input.checked = (option.value === defaultValue);
            input.dataset.elementType = 'radio';
            if (adjustedColor) input.style.accentColor = adjustedColor;
            const optionLabel = document.createElement('label');
            optionLabel.htmlFor = inputId;
            optionLabel.textContent = option.label;
            optionLabel.className = "flex-grow cursor-pointer";
            optionDiv.appendChild(input);
            optionDiv.appendChild(optionLabel);
            wrapper.appendChild(optionDiv);
        });
    } else {
        wrapper.innerHTML += `<p class="text-sm text-red-600">Error: No valid options for radio group '${element.name}'.</p>`;
    }
}

// --- Utility Functions ---
function collectInputState() {
    const inputs = {};
    uiContainer.querySelectorAll('[data-element-type]').forEach(el => {
        const name = el.name;
        if (!name) return;
        const type = el.dataset.elementType;
        switch (type) {
            case 'textfield':
                inputs[name] = el.value;
                break;
            case 'checkbox':
                inputs[name] = el.checked;
                break;
            case 'slider':
                inputs[name] = parseFloat(el.value);
                break;
            case 'radio':
                if (el.checked) inputs[name] = el.value;
                break;
        }
    });
    inputs['turn'] = historyQueue.length + 1;
    return JSON.stringify(inputs);
}

function setLoading(loading) {
    isLoading = loading;
    loadingIndicator.style.display = loading ? 'flex' : 'none';
    const keyPresent = apiKeyInput.value.trim().length > 0;
    submitButton.disabled = loading || !(apiKeyLocked || keyPresent);
    modeToggleButton.disabled = loading;
    resetGameButton.disabled = loading || !apiKeyLocked;
    uiContainer.querySelectorAll('input, textarea, button, .analysis-toggle-container, .geems-radio-option, .geems-checkbox-option').forEach(el => {
        if (el.id !== 'submit-turn' && el.id !== 'modeToggleButton' && el.id !== 'resetGameButton') {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON') el.disabled = loading;
            if (el.classList.contains('geems-radio-option') || el.classList.contains('geems-checkbox-option') || el.classList.contains('analysis-toggle-container') || el.closest('.geems-slider-container')) {
                el.style.opacity = loading ? 0.5 : 1.0;
                el.style.pointerEvents = loading ? 'none' : 'auto';
                el.querySelectorAll('.geems-slider').forEach(slider => slider.disabled = loading);
            }
        }
    });
}

function showError(message) {
    errorDisplay.textContent = message;
    errorDisplay.style.display = 'block';
}

function hideError() {
    errorDisplay.textContent = '';
    errorDisplay.style.display = 'none';
}

function isValidHexColor(hex) {
    return typeof hex === 'string' && /^#[0-9A-F]{6}$/i.test(hex);
}

function adjustColorForContrast(hex) {
    if (!isValidHexColor(hex)) return hex;
    let r = parseInt(hex.substring(1, 3), 16), g = parseInt(hex.substring(3, 5), 16),
        b = parseInt(hex.substring(5, 7), 16);
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
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
    if (l > MIN_CONTRAST_LIGHTNESS) {
        l = MIN_CONTRAST_LIGHTNESS * 0.9;
        let r1, g1, b1;
        if (s === 0) r1 = g1 = b1 = l; else {
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
        const toHex = x => {
            const hexVal = Math.round(x * 255).toString(16);
            return hexVal.length === 1 ? '0' + hexVal : hexVal;
        };
        return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
    }
    return hex;
}

function showClipboardMessage(message, isError = false) {
    clipboardMessage.textContent = message;
    clipboardMessage.style.color = isError ? '#dc2626' : '#16a34a';
    setTimeout(() => {
        clipboardMessage.textContent = '';
    }, 3000);
}

function updateModeButtonVisuals() {
    if (isMasturbationMode) {
        modeToggleButton.textContent = 'Mode: Explicit';
        modeToggleButton.classList.remove('standard-mode');
    } else {
        modeToggleButton.textContent = 'Mode: Standard';
        modeToggleButton.classList.add('standard-mode');
    }
}

function setDynamicImages() {
    const headerSeed = Math.floor(Math.random() * 65536), footerSeed = Math.floor(Math.random() * 65536);
    const headerPrompt = "wide cinematic vivid colorful abstract emotional landscape brainwaves",
        footerPrompt = "wide abstract colorful digital roots network connections";
    if (headerBanner) {
        headerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(headerPrompt)}?width=1200&height=200&seed=${headerSeed}&nologo=true&safe=false`;
        headerBanner.alt = headerPrompt;
    }
    if (footerBanner) {
        footerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(footerPrompt)}?width=1200&height=100&seed=${footerSeed}&nologo=true&safe=false`;
        footerBanner.alt = footerPrompt;
    }
}

// --- Modal Functions ---
/** Displays the modal with the hidden analysis content. */
function showAnalysisModal() {
    // Check if modal elements exist
    if (!analysisModal || !analysisModalBody) {
        console.error("Analysis modal elements not found in the DOM.");
        showError("Cannot display analysis: Modal elements missing.");
        return;
    }

    if (hiddenAnalysisContent) {
        // Basic HTML rendering (similar to renderText)
        analysisModalBody.innerHTML = (hiddenAnalysisContentTweet + "\n\n" + hiddenAnalysisContent + "\n\nSystem notes: " + hiddenAnalysisContentNotes)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
            .replace(/\*(.*?)\*/g, '<em>$1</em>')       // Italics
            .replace(/```([\s\S]*?)```/g, (match, p1) => `<pre>${p1.trim()}</pre>`) // Code blocks
            .replace(/\n/g, '<br>'); // Newlines
    } else {
        analysisModalBody.innerHTML = '<p>No analysis content available for this turn.</p>';
    }
    analysisModal.style.display = 'block'; // Or 'flex', depending on your CSS
}

/** Hides the analysis modal. */
function hideAnalysisModal() {
    if (analysisModal) {
        analysisModal.style.display = 'none';
    }
}

// --- Multiplayer Functions ---

/** Shows a basic notification */
function showNotification(message, type = 'info', duration = 4000) {
    // Use your existing showClipboardMessage or create a dedicated notification area
    console.log(`[Notification-${type}] ${message}`);
    showClipboardMessage(message, type === 'error' || type === 'warn');
    // If you have a dedicated notification area:
    // const notificationArea = document.getElementById('notification-area');
    // if(notificationArea) { ... create and append element ... }
}


/** Updates the peer list UI in the footer */
function updatePeerListUI() {
    if (!peerListContainer) return; // Check if container exists
    peerListContainer.innerHTML = ''; // Clear previous icons

    const peers = MPLib.getConnections ? Array.from(MPLib.getConnections().keys()) : [];
    const localId = MPLib.getLocalPeerId ? MPLib.getLocalPeerId() : null;
    const hostId = MPLib.getHostPeerId ? MPLib.getHostPeerId() : null;
    const isViewingRemote = localGameStateSnapshot !== null;

    // Add local player icon
    if (localId) {
        const localIcon = createPeerIcon(localId, 'You', true, localId === hostId); // isSelf=true, isHost=isHost
        localIcon.onclick = () => {
            if (isViewingRemote) {
                console.log("Clicked local icon - restoring local state.");
                restoreLocalState();
                // Submit button state is handled within restoreLocalState
                // Highlight is cleared within restoreLocalState calling this function again
            } else {
                console.log("Clicked local icon - already viewing local state.");
            }
        };
        peerListContainer.appendChild(localIcon);
    }

    // Add remote peer icons
    peers.forEach(peerId => {
        if (peerId !== localId) { // Don't add self again
            const conn = MPLib.getConnections().get(peerId);
            // Check for valid connection object (MPLib might store 'connecting' string temporarily)
            if (conn && typeof conn === 'object' && conn.open) { // Ensure it's an open DataConnection
                const isPeerHost = peerId === hostId;
                const peerIcon = createPeerIcon(peerId, peerId.slice(-6), false, isPeerHost);
                peerIcon.onclick = () => {
                    console.log(`Clicked remote peer icon: ${peerId.slice(-6)}`);
                    // Request game state from this peer
                    console.log(`Requesting game state from ${peerId.slice(-6)}...`);
                    MPLib.sendDirect(peerId, {type: 'request_game_state'});
                    showNotification(`Requesting state from ${peerId.slice(-6)}...`, 'info', 2000);
                    // Highlight this peer (will be updated fully when state arrives)
                    highlightPeerIcon(peerId); // Indicate attempt to view
                    // submitButton.disabled = true; // Handled in loadGameState
                }
                peerListContainer.appendChild(peerIcon);

            } else {
                console.log(`Skipping peer icon for ${peerId.slice(-6)} - connection not fully established or is invalid.`);
                // Optionally add a placeholder icon for connecting peers
            }
        }
    });


    // Highlight the peer whose state is currently being viewed
    // Highlighting is now mainly handled by calls to highlightPeerIcon when clicking or receiving state.
    // Ensure no highlights if viewing local state
    if (!isViewingRemote) {
        highlightPeerIcon(null); // Clear highlights if viewing local
    }
}

/** Creates a single peer icon element */
function createPeerIcon(peerId, labelText, isSelf, isHost) {
    const iconWrapper = document.createElement('div');
    iconWrapper.className = 'peer-icon-wrapper tooltip';
    iconWrapper.dataset.peerId = peerId;

    const icon = document.createElement('span');
    icon.className = 'peer-icon';
    icon.style.backgroundColor = isSelf ? '#4f46e5' : '#71717a'; // Blue for self, gray for others
    if (isHost) {
        icon.style.borderColor = '#facc15'; // Yellow border for host
        icon.style.borderWidth = '2px';
        icon.style.borderStyle = 'solid';
    }
    // Add simple initial/icon, e.g., first letter of label
    icon.textContent = labelText.slice(-4).toUpperCase();

    // Tooltip text
    const tooltipText = document.createElement('span');
    tooltipText.className = 'tooltiptext';
    tooltipText.textContent = `${labelText}${isHost ? ' (Host)' : ''} - ${peerId}`;

    iconWrapper.appendChild(icon);
    iconWrapper.appendChild(tooltipText);

    return iconWrapper;
}

/** Highlights a specific peer icon */
function highlightPeerIcon(peerIdToHighlight) {
    if (!peerListContainer) return;
    peerListContainer.querySelectorAll('.peer-icon-wrapper').forEach(icon => {
        if (icon.dataset.peerId === peerIdToHighlight) {
            icon.classList.add('viewing');
            // Ensure self icon isn't highlighted if viewing remote
            if (peerIdToHighlight !== MPLib.getLocalPeerId()) {
                const selfIcon = peerListContainer.querySelector(`.peer-icon-wrapper[data-peer-id="${MPLib.getLocalPeerId()}"]`);
                if (selfIcon) selfIcon.classList.remove('viewing');
            }
        } else {
            icon.classList.remove('viewing');
        }
    });
    // Ensure local icon is highlighted if no remote peer is specified (i.e., back to local view)
    if (peerIdToHighlight === null && MPLib.getLocalPeerId()) {
        const selfIcon = peerListContainer.querySelector(`.peer-icon-wrapper[data-peer-id="${MPLib.getLocalPeerId()}"]`);
        if (selfIcon) selfIcon.classList.add('viewing');
    }
}

/** Add CSS for Peer Icons and Tooltips (inject or add to styles.css) */
function addPeerIconStyles() {
    const styleId = 'peer-icon-styles';
    if (document.getElementById(styleId)) return; // Avoid adding multiple times

    const css = `
        .peer-list-container {
            display: flex;
            gap: 0.75rem; /* 12px */
            padding: 0.5rem 1rem; /* 8px 16px */
            justify-content: center;
            align-items: center;
            background-color: rgba(255, 255, 255, 0.1); /* Slightly transparent background */
            border-top: 1px solid rgba(209, 213, 219, 0.5); /* Light border */
            margin-top: 1rem; /* Space above peer list */
            flex-wrap: wrap; /* Allow wrapping on small screens */
        }
        .peer-icon-wrapper {
            position: relative;
            display: inline-block;
        }
        .peer-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2.5rem; /* 40px */
            height: 2.5rem; /* 40px */
            border-radius: 50%;
            color: white;
            font-weight: bold;
            font-size: 1rem; /* 16px */
            cursor: pointer;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
            box-sizing: border-box; /* Include border in size */
            user-select: none; /* Prevent text selection */
            -webkit-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
        }
        .peer-icon-wrapper:hover .peer-icon {
            transform: scale(1.1);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
        }
        /* Highlight style for viewing peer/self */
        .peer-icon-wrapper.viewing .peer-icon {
             /* Use a distinct outline or shadow to indicate viewing */
             outline: 3px solid #a78bfa; /* Purple outline */
             outline-offset: 2px;
             box-shadow: 0 0 10px rgba(167, 139, 250, 0.7); /* Optional glow */
             /* transform: scale(1.05); // Can conflict with hover */
        }
        /* Tooltip styles */
        .tooltip .tooltiptext {
            visibility: hidden;
            width: max-content; /* Adjust width based on content */
            max-width: 200px; /* Max width */
            background-color: #555;
            color: #fff;
            text-align: center;
            border-radius: 6px;
            padding: 5px 8px;
            position: absolute;
            z-index: 10;
            bottom: 135%; /* Position above the icon */
            left: 50%;
            transform: translateX(-50%); /* Center the tooltip using transform */
            opacity: 0;
            transition: opacity 0.3s;
            font-size: 0.75rem; /* 12px */
            word-wrap: break-word; /* Prevent long IDs from breaking layout */
            pointer-events: none; /* Tooltip should not interfere with clicks */
        }
        .tooltip:hover .tooltiptext {
            visibility: visible;
            opacity: 1;
        }
        .tooltip .tooltiptext::after { /* Tooltip arrow */
            content: "";
            position: absolute;
            top: 100%;
            left: 50%;
            margin-left: -5px;
            border-width: 5px;
            border-style: solid;
            border-color: #555 transparent transparent transparent;
        }
    `;
    const styleSheet = document.createElement("style");
    styleSheet.id = styleId;
    styleSheet.type = "text/css";
    styleSheet.innerText = css;
    document.head.appendChild(styleSheet);
}


// --- Multiplayer Event Handlers (Callbacks for MPLib) ---

function handlePeerJoined(peerId, conn) {
    console.log(`MPLib Event: Peer joined - ${peerId.slice(-6)}`);
    showNotification(`Peer ${peerId.slice(-6)} connected.`, 'success', 2000);
    updatePeerListUI();
    // Optional: If you are host, maybe send them the current state immediately?
    // MPLib handles initial sync, but subsequent joins might need updates.
    // Example: if (MPLib.isHost() && apiKeyLocked) { // Only send if game started
    //     const currentState = getCurrentGameState();
    //     MPLib.sendDirect(peerId, { type: 'game_state', payload: currentState });
    // }
}

function handlePeerLeft(peerId) {
    console.log(`MPLib Event: Peer left - ${peerId.slice(-6)}`);
    showNotification(`Peer ${peerId.slice(-6)} disconnected.`, 'warn', 2000);
    remoteGameStates.delete(peerId); // Remove any stored state for this peer

    // If we were viewing this peer's state, restore local state
    const isViewingRemote = localGameStateSnapshot !== null;
    // A simple check: If we are in remote view mode AND the leaving peer MIGHT be the one we were viewing
    // (More robust would be storing `currentlyViewingPeerId`)
    if (isViewingRemote && remoteGameStates.size === 0) { // Or if viewingPeerId === peerId
        console.log(`Peer ${peerId.slice(-6)} left while being viewed (or was last viewed). Restoring local state.`);
        restoreLocalState();
    } else {
        updatePeerListUI(); // Just update the list if not viewing the leaving peer
    }
}

function handleDataReceived(senderId, data) {
    console.log(`MPLib Event: Data received from ${senderId.slice(-6)}`, data);
    if (!data || !data.type) {
        console.warn("Received data without type from peer:", senderId.slice(-6));
        return;
    }

    switch (data.type) {
        case 'request_game_state':
            console.log(`Received game state request from ${senderId.slice(-6)}`);
            // Only send state if the game has started (API key locked)
            if (apiKeyLocked && currentUiJson) {
                const currentState = getCurrentGameState();
                MPLib.sendDirect(senderId, {type: 'game_state', payload: currentState});
                console.log(`Sent current game state back to ${senderId.slice(-6)}`);
            } else {
                console.log(`Game not started or no UI yet, cannot send state to ${senderId.slice(-6)}.`);
                // Optionally send a message indicating game not ready
                MPLib.sendDirect(senderId, {type: 'game_state_not_ready'});
            }
            break;
        case 'game_state':
            console.log(`Received game state from ${senderId.slice(-6)}`);
            if (data.payload) {
                remoteGameStates.set(senderId, data.payload); // Store the received state
                loadGameState(data.payload, senderId); // Load the received state for viewing
                // updatePeerListUI is called within loadGameState
            } else {
                console.warn("Received game_state message with no payload.");
                showNotification(`Failed to load state from ${senderId.slice(-6)}.`, "error", 3000);
                highlightPeerIcon(null); // Clear potential highlight if state load failed
                submitButton.disabled = false; // Re-enable submit if state load failed
            }
            break;
        case 'game_state_not_ready':
            console.log(`Received game_state_not_ready from ${senderId.slice(-6)}`);
            showNotification(`Peer ${senderId.slice(-6)}'s game has not started yet.`, "info", 3000);
            highlightPeerIcon(null); // Clear potential highlight
            submitButton.disabled = false; // Re-enable submit locally
            break;
        case 'game_state_update':
            console.log(`Received game state update broadcast from ${senderId.slice(-6)}`);
            // Store this update if needed.
            if (data.payload) {
                remoteGameStates.set(senderId, data.payload); // Update stored state
                const isViewingRemote = localGameStateSnapshot !== null;
                // If user is currently viewing THIS peer, refresh the view
                // (Requires tracking `currentlyViewingPeerId`, simplified check here)
                const viewingIcon = peerListContainer?.querySelector('.peer-icon-wrapper.viewing');
                if (isViewingRemote && viewingIcon && viewingIcon.dataset.peerId === senderId) {
                    console.log(`Auto-refreshing view for peer ${senderId.slice(-6)}.`);
                    loadGameState(data.payload, senderId); // Refresh view
                } else {
                    // Just notify if not actively viewing this peer
                    showNotification(`Received state update from ${senderId.slice(-6)}.`, 'info', 1500);
                }
            }
            break;
        // Add other custom message types your game needs
        default:
            console.warn(`Received unknown message type '${data.type}' from ${senderId.slice(-6)}`);
    }
}

function handleStatusUpdate(message) {
    console.log(`MPLib Status: ${message}`);
    // Optionally display less critical status updates somewhere
    // showNotification(message, 'info', 1500);
}

function handleError(type, error) {
    console.error(`MPLib Error (${type}):`, error);
    //showError(`Network Error (${type}): ${error?.message || error || 'Unknown error'}`);
}

function handleBecameHost() {
    console.log("This client BECAME THE HOST.");
    showNotification("You are now the host!", 'success');
    updatePeerListUI();
    // Host specific logic might go here
}

function handleConnectedToHost(hostId) {
    console.log(`Successfully connected to HOST: ${hostId}`);
    showNotification(`Connected to host ${hostId.slice(-6)}`, 'success');
    updatePeerListUI();
    // Client specific logic after connecting might go here
    // Maybe request state from host automatically?
    // console.log(`Requesting initial game state from host ${hostId.slice(-6)}...`);
    // MPLib.sendDirect(hostId, { type: 'request_game_state' });
}


// --- Event Listeners ---
    h1.addEventListener('click', () => {
        showAnalysisModal()
    })


// Modify the original click listener
submitButton.addEventListener('click', () => {
    // --- Original Short Click Action ---
    console.log("Submit button clicked (short press).");
    initAudioContext();
    const playerActions = collectInputState();
    if (isLoading) return;
    fetchTurnData(playerActions);
    // --- End Original Short Click Action ---
});
// --- MODIFICATION END: Long Press Logic ---


apiKeyInput.addEventListener('input', () => {
    const keyPresent = apiKeyInput.value.trim().length > 0;
    submitButton.disabled = isLoading || !(apiKeyLocked || keyPresent);
    resetGameButton.disabled = isLoading || (!apiKeyLocked && !keyPresent);
    if (apiKeySection.style.display !== 'none') {
        const currentInitialMessage = document.getElementById('initial-message');
        if (keyPresent) {
            hideError();
            if (currentInitialMessage && currentInitialMessage.style.display !== 'none') currentInitialMessage.textContent = 'API Key entered. Click "Submit Turn" to begin!';
        } else {
            if (currentInitialMessage) {
                currentInitialMessage.innerHTML = 'Enter API Key';
                currentInitialMessage.style.display = 'block';
            }
        }
    }
});

modeToggleButton.addEventListener('click', () => {
    if (isLoading) return;
    isMasturbationMode = !isMasturbationMode;
    console.log(`Mode Toggled: ${isMasturbationMode ? 'Explicit' : 'Standard'}`);
    updateModeButtonVisuals();
    autoSaveGameState();
});

resetGameButton.addEventListener('click', () => {
    if (isLoading || resetGameButton.disabled) return;
    if (confirm('Reset game? This will clear local progress. Are you sure?')) {
        console.log("Resetting game state...");
        historyQueue = [];
        currentUiJson = null;
        currentNotes = {};
        currentSubjectId = "";
        currentModelIndex = 0;
        apiKeyLocked = false;
        hiddenAnalysisContent = null; // Clear analysis content
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        console.log("Cleared localStorage.");
        uiContainer.innerHTML = '';
        hideError();
        if (apiKeySection) apiKeySection.style.display = 'block';
        let currentInitialMessage = document.getElementById('initial-message') || createInitialMessage();
        currentInitialMessage.style.display = 'block';
        currentInitialMessage.innerHTML = 'Enter secure API Key to begin'
        const keyPresent = apiKeyInput.value.trim().length > 0;
        setLoading(false);
        submitButton.disabled = !keyPresent;
        resetGameButton.disabled = !keyPresent;
        modeToggleButton.disabled = false;
        updateModeButtonVisuals();

        // // --- Multiplayer Reset ---
        // if (MPLib && typeof MPLib.disconnect === 'function') {
        //     console.log("Disconnecting from multiplayer network.");
        //     MPLib.disconnect();
        // } else if (MPLib && MPLib.peer && !MPLib.peer.destroyed) {
        //     try { MPLib.peer.destroy(); console.log("Destroyed PeerJS object."); } catch (e) { console.error("Error destroying PeerJS object:", e); }
        // }
        // remoteGameStates.clear(); // Clear stored remote states
        // localGameStateSnapshot = null; // Clear local snapshot
        // if (peerListContainer) peerListContainer.innerHTML = ''; // Clear peer list UI
        // console.log("Multiplayer state reset.");
        // Re-initialize multiplayer? Or require manual reconnect?
        // Let's assume reset means full stop for now. User would refresh/rejoin.
    }
});

// Add listener for the modal close button (if it exists)
if (analysisModalClose) {
    analysisModalClose.addEventListener('click', hideAnalysisModal);
}
// Optional: Close modal if clicking outside the content area
if (analysisModal) {
    analysisModal.addEventListener('click', (event) => {
        // Check if the click was directly on the modal background, not the content area
        if (event.target === analysisModal) {
            hideAnalysisModal();
        }
    });
}


// --- Initial Game Setup ---
function initializeGame() {
    console.log("Initializing GEEMS...");
    let autoStarted = false;
    const storedStateString = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (storedStateString) {
        console.log("Found saved state. Attempting restore...");
        let savedState;
        try {
            savedState = JSON.parse(storedStateString);
            const decodedApiKey = decodeApiKey(savedState.encodedApiKey);
            if (!decodedApiKey) throw new Error("Failed to decode API key.");
            apiKeyInput.value = decodedApiKey;
            historyQueue = savedState.historyQueue || [];
            currentUiJson = savedState.currentUiJson || null;
            isMasturbationMode = savedState.isMasturbationMode === true;
            currentModelIndex = savedState.currentModelIndex || 0;
            apiKeyLocked = true;
            autoStarted = true;
            console.log("State restored from localStorage.");
            setDynamicImages();
            if (currentUiJson) renderUI(currentUiJson); else throw new Error("Restored state incomplete (missing UI).");
            updateModeButtonVisuals();
            apiKeySection.style.display = 'none';
            const msg = document.getElementById('initial-message');
            if (msg) msg.style.display = 'none';
            hideError();
            setLoading(false);
        } catch (error) {
            console.error("Error restoring state:", error);
            showError(`Error restoring saved state: ${error.message}. Start manually.`);
            localStorage.removeItem(LOCAL_STORAGE_KEY);
            historyQueue = [];
            currentUiJson = null;
            isMasturbationMode = false;
            currentModelIndex = 0;
            apiKeyLocked = false;
            autoStarted = false;
            apiKeyInput.value = '';
            uiContainer.innerHTML = '';
            const initialMsg = document.getElementById('initial-message') || createInitialMessage();
            initialMsg.style.display = 'block';
            initialMsg.innerHTML = 'Error restoring. Enter API Key';
            if (apiKeySection) apiKeySection.style.display = 'block';
            setLoading(false);
            setDynamicImages();
        }
    }
    if (!autoStarted) {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const keyFromUrlParam = urlParams.get('apiKey');
            if (keyFromUrlParam) {
                console.log("API Key from URL. Auto-starting...");
                apiKeyInput.value = keyFromUrlParam;
                apiKeyLocked = false;
                currentModelIndex = 0;
                isMasturbationMode = false;
                historyQueue = [];
                currentUiJson = null;
                hiddenAnalysisContent = null;
                if (apiKeySection) apiKeySection.style.display = 'none';
                const msg = document.getElementById('initial-message') || createInitialMessage();
                msg.style.display = 'none';
                const currentUrl = new URL(window.location.href);
                currentUrl.searchParams.delete('apiKey');
                window.history.replaceState(null, '', currentUrl.toString());
                setDynamicImages();
                fetchTurnData("{}");
                autoStarted = true;
                setLoading(true);
                updateModeButtonVisuals();
                modeToggleButton.disabled = true;
                resetGameButton.disabled = true;
            }
        } catch (e) {
            console.error("Error processing URL params:", e);
            showError("Error reading URL params. Start manually.");
            autoStarted = false;
        }
    }
    if (!autoStarted) {
        console.log("Manual start.");
        historyQueue = [];
        currentUiJson = null;
        isMasturbationMode = false;
        currentModelIndex = 0;
        apiKeyLocked = false;
        hiddenAnalysisContent = null;
        uiContainer.innerHTML = '';
        const initialMsg = document.getElementById('initial-message') || createInitialMessage();
        initialMsg.style.display = 'block';
        initialMsg.innerHTML = 'Enter API Key';
        if (apiKeySection) apiKeySection.style.display = 'block';
        apiKeyInput.value = '';
        setLoading(false);
        hideError();
        updateModeButtonVisuals();
        setDynamicImages();
    }

    // --- Initialize Multiplayer AFTER initial setup ---
    if (typeof MPLib !== 'undefined' && typeof MPLib.initialize === 'function') {
        console.log("Initializing Multiplayer Library...");
        addPeerIconStyles(); // Add styles if not already present
        // Create peer list container in the footer
        if (footerElement && !peerListContainer) {
            peerListContainer = document.createElement('div');
            peerListContainer.id = 'peer-list';
            peerListContainer.className = 'peer-list-container'; // Add class for styling
            // Insert before the copyright/content div in the footer
            const footerContent = footerElement.querySelector('.footer-content');
            if (footerContent) {
                footerElement.insertBefore(peerListContainer, footerContent);
            } else {
                footerElement.appendChild(peerListContainer); // Fallback append
            }
        }

        MPLib.initialize({
            targetHostId: DEFAULT_HOST_ID, // Use the defined host ID
            debugLevel: 1, // Set desired debug level
            onStatusUpdate: handleStatusUpdate,
            onError: handleError,
            onPeerJoined: handlePeerJoined,
            onPeerLeft: handlePeerLeft,
            onDataReceived: handleDataReceived,
            onConnectedToHost: handleConnectedToHost,
            onBecameHost: handleBecameHost,
            getInitialSyncData: () => apiKeyLocked ? getCurrentGameState() : null, // Only provide sync data if game started
            onInitialSync: (syncData) => { // Handle receiving sync data when joining
                if (syncData) {
                    console.log("Received initial sync data from host.");
                    // Check if we haven't already started a local game
                    if (!apiKeyLocked && !currentUiJson) {
                        console.log("Applying initial sync data to start game.");
                        // We need the API key to continue! Sync data doesn't contain it.
                        // This approach needs refinement. Maybe sync only happens *after* local API key entered?
                        // Or the host needs to trigger a state send *after* client confirms API key?
                        // For now, let's just log it. A robust sync needs more thought.
                        // loadGameState(syncData, MPLib.getHostPeerId()); // Load the state
                        // apiKeyLocked = true; // Assume sync means game is running? Risky without key.
                        // apiKeySection.style.display = 'none';
                        showNotification("Received initial state from host. Enter *your* API key to participate fully.", "info", 6000);
                        // The user still needs their own key to *send* turns.
                        // Viewing host state might be possible without a local key if designed that way.
                    } else {
                        console.log("Already have local game state, ignoring initial sync data for now.");
                        // Maybe offer to switch to host state?
                    }
                } else {
                    console.log("Connected to host, but no initial sync data received (host game might not have started).");
                }
            }
        });
    } else {
        console.warn("MPLib not found or initialize function missing.");
    }

}

function createInitialMessage() {
    const msgDiv = document.createElement('div');
    msgDiv.id = 'initial-message';
    msgDiv.className = 'text-center text-gray-500 p-6 bg-white rounded-lg shadow';
    uiContainer.appendChild(msgDiv);
    return msgDiv;
}

// Ensure DOM is fully loaded before initializing
document.addEventListener('DOMContentLoaded', initializeGame);
let randomPeerClickInterval;


randomPeerClickInterval = setInterval(() => {
    if (apiKeyInput.value.trim().length === 0) {
        const peerIcons = Array.from(peerListContainer.querySelectorAll('.peer-icon-wrapper'));
        const randomPeerIcon = peerIcons[Math.floor(Math.random() * peerIcons.length)];
        if (randomPeerIcon) {
            randomPeerIcon.click();
        }
    }
}, 10000);

