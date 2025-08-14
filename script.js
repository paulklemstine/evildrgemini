// Import prompts from the separate file (if still needed for single-player)
import {geemsPrompts} from './prompts.js';
import MPLib from './mp.js';

// --- Game State Variables ---
let historyQueue = [];
const MAX_HISTORY_SIZE = 20;
let currentUiJson = null;
let currentNotes = {};
let currentSubjectId = "";
let isMasturbationMode = false; // Default mode
let isLoading = false;
// apiKeyLocked is always true now, as no key is needed.
let apiKeyLocked = true;
let localGameStateSnapshot = null; // To store local state when viewing remote state
let hiddenAnalysisContent = null; // To store content of gemini_facing_analysis for modal
let hiddenAnalysisContentTweet = null; // To store content of gemini_facing_analysis for modal
let hiddenAnalysisContentNotes = null; // To store content of gemini_facing_analysis for modal

// --- Model Switching State ---
const AVAILABLE_MODELS = [
    "gemini-2.5-flash-preview-05-20",
    "gemini-pro", // A common and reliable model
];
let currentModelIndex = 0;

// --- Configuration ---
const MIN_CONTRAST_LIGHTNESS = 0.55;
const LOCAL_STORAGE_KEY = 'geemsGameStateToRestore_Free'; // Use a new key for the free version
const DEFAULT_HOST_ID = 'geems-default-game-host';

// --- DOM Element References ---
const uiContainer = document.getElementById('ui-elements');
const loadingIndicator = document.getElementById('loading');
const submitButton = document.getElementById('submit-turn');
// API Key elements are no longer needed for core logic but might be referenced, so we keep the reference but hide the element.
const apiKeyInput = document.getElementById('apiKeyInput');
const apiKeySection = document.getElementById('apiKeySection');
const errorDisplay = document.getElementById('error-display');
const modeToggleButton = document.getElementById('modeToggleButton');
const resetGameButton = document.getElementById('resetGameButton');
const clipboardMessage = document.getElementById('clipboardMessage');
const headerBanner = document.getElementById('headerBanner');
const footerBanner = document.getElementById('footerBanner');
const footerElement = document.querySelector('.site-footer');
const h1 = document.querySelector('h1');
let peerListContainer = null;
const analysisModal = document.getElementById('analysisModal');
const analysisModalBody = document.getElementById('analysisModalBody');
const analysisModalClose = document.getElementById('analysisModalClose');

// --- Web Audio API Context ---
let audioCtx = null;

// --- Multiplayer State ---
const remoteGameStates = new Map(); // Map<peerId, gameState>

// --- Helper Functions ---

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
    if (!currentUiJson || !historyQueue) return;
    try {
        const stateToSave = {
            // No need to save API key
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
    return {
        currentUiJson: currentUiJson,
        historyQueue: historyQueue,
        currentSubjectId: currentSubjectId,
    };
}

/** Loads a game state received from a peer. */
function loadGameState(newState, sourcePeerId = null) {
    if (!newState) {
        console.error("Attempted to load null game state.");
        return;
    }
    console.log(`Loading game state${sourcePeerId ? ` from peer ${sourcePeerId.slice(-6)}` : ''}`);
    saveLocalState();
    currentUiJson = newState.currentUiJson || null;
    historyQueue = newState.historyQueue || [];
    currentSubjectId = newState.currentSubjectId || "Peer";
    if (currentUiJson) {
        renderUI(currentUiJson);
        console.log("Loaded game state UI rendered.");
        submitButton.disabled = false;
        showNotification(`Viewing ${sourcePeerId ? sourcePeerId.slice(-6) : 'remote'} state. Click your icon to return.`, 'info', 5000);
    } else {
        showError("Loaded game state is missing UI data.");
    }
    updatePeerListUI();
    highlightPeerIcon(sourcePeerId);
}

/** Saves the current local game state snapshot. */
function saveLocalState() {
    console.log("Saving local game state snapshot.");
    localGameStateSnapshot = {
        currentUiJson: JSON.parse(JSON.stringify(currentUiJson)),
        historyQueue: JSON.parse(JSON.stringify(historyQueue)),
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
        localGameStateSnapshot = null;
        if (currentUiJson) {
            renderUI(currentUiJson);
            console.log("Restored local game state UI rendered.");
            submitButton.disabled = isLoading;
            updatePeerListUI();
            showNotification("Returned to your game state.", "info", 2000);
        } else {
            showError("Error restoring local game state: UI data missing.");
        }
    } else {
        console.warn("No local game state snapshot to restore.");
    }
}

/** Processes the successful response from the Gemini API. */
function processSuccessfulResponse(responseJson, playerActionsJson) {
    currentUiJson = responseJson;
    renderUI(currentUiJson);
    playTurnAlertSound();
    autoSaveGameState();
    broadcastGameState();
}

/** Broadcasts the current game state to all connected peers */
function broadcastGameState() {
    if (!MPLib || MPLib.getConnections().size === 0) return;
    const stateToSend = getCurrentGameState();
    console.log("Broadcasting game state update to peers.");
    MPLib.broadcast({
        type: 'game_state_update',
        payload: stateToSend
    });
}

/** Fetches the next turn's UI data from the Gemini API. */
async function fetchTurnData(playerActionsJson) {
    updateHistoryQueue(playerActionsJson);
    console.log("fetchTurnData called.");
    initAudioContext();

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
            const jsonStringResponse = await callRealGeminiAPI(fullPrompt, currentModel);
            const responseJson = JSON.parse(jsonStringResponse);
            console.log(`Parsed API response from ${currentModel}.`);
            processSuccessfulResponse(responseJson, playerActionsJson);
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
        showError(`Failed to get response after ${maxAttempts} attempts. Check network or try later.`);
    } else {
        hideError();
        window.scrollTo({top: 0, behavior: 'smooth'});
    }
    setLoading(false);
}

/** Calls the free Google AI (Gemini) API. */
async function callRealGeminiAPI(promptText, modelName) {
    const apiKey = ""; // API key is an empty string for the free tier.
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const requestBody = {
        contents: [{parts: [{text: promptText}]}],
        generationConfig: {temperature: 1.0, response_mime_type: "application/json"},
        safetySettings: [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
        ]
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
            try { errorBody += `: ${await response.text()}`; } catch (e2) {}
        }
        console.error("API Error:", errorBody);
        throw new Error(errorBody);
    }
    const responseData = await response.json();
    if (responseData.promptFeedback && responseData.promptFeedback.blockReason) throw new Error(`Request blocked. Reason: ${responseData.promptFeedback.blockReason}.`);
    if (!responseData.candidates || responseData.candidates.length === 0) {
        throw new Error('No candidates or unexpected API response.');
    }
    const candidate = responseData.candidates[0];
    if (candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
        if (candidate.finishReason === "SAFETY") throw new Error(`API call finished due to SAFETY.`);
        else if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) throw new Error(`API call finished unexpectedly (${candidate.finishReason}) and no content.`);
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

// --- All UI Rendering and Utility Functions remain largely the same ---
// (renderUI, renderSingleElement, renderImage, renderText, etc.)
// ... The rest of your rendering, utility, and multiplayer functions go here ...
// I will include them for completeness, without modification unless necessary.

/** Renders the UI elements based on the JSON array. */
function renderUI(uiJsonArray) {
    console.log("renderUI started.");
    hiddenAnalysisContent = null;
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
    if (element.type === 'text' && element.name?.includes('gemini_facing_analysis')) {
        hiddenAnalysisContent = element.text || element.value || '';
        console.log("Stored hidden 'gemini_facing_analysis' content.");
        return;
    }
    if (element.name?.includes('tweet')) {
        hiddenAnalysisContentTweet = element.text || element.value || '';
        console.log("Stored hidden 'tweet' content.");
        return;
    }
    if (element.name?.includes('notes')) {
        hiddenAnalysisContentNotes = element.value || '';
        console.log("Stored hidden 'notes' content.");
        return;
    }

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
            case 'image': renderImage(wrapper, element, adjustedColor); break;
            case 'text': renderText(wrapper, element, adjustedColor); break;
            case 'textfield': renderTextField(wrapper, element, adjustedColor); break;
            case 'checkbox': renderCheckbox(wrapper, element, adjustedColor); break;
            case 'slider': renderSlider(wrapper, element, adjustedColor); break;
            case 'radio': renderRadio(wrapper, element, adjustedColor); break;
            case 'hidden':
                if (element.name === 'notes') currentNotes = element.value || null;
                else if (element.name === 'subjectId') currentSubjectId = element.value || "";
                return;
            default:
                console.warn("Unknown element type:", element.type, element);
                wrapper.textContent = `Unknown element type: ${element.type}`;
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
    const useLabel = element.label && !['narrative', 'divine_wisdom', 'player_facing_analysis'].some(namePart => element.name?.includes(namePart));
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
    }
    const valueDisplay = document.createElement('span');
    valueDisplay.className = `geems-slider-value-display font-medium w-auto text-right`;
    valueDisplay.textContent = input.value;
    if (adjustedColor) valueDisplay.style.color = adjustedColor;
    input.oninput = () => { valueDisplay.textContent = input.value; };
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
                let currentLabel = '', currentValue = '';
                if (typeof opt === 'object' && opt !== null && opt.value !== undefined) {
                    currentValue = String(opt.value);
                    currentLabel = opt.label !== undefined ? String(opt.label) : currentValue;
                    if (currentLabel.startsWith('*')) {
                        defaultValue = currentValue;
                        currentLabel = currentLabel.substring(1);
                    }
                } else {
                    currentValue = String(opt);
                    currentLabel = currentValue;
                    if (currentLabel.startsWith('*')) {
                        defaultValue = currentValue.substring(1);
                        currentValue = defaultValue;
                        currentLabel = defaultValue;
                    }
                }
                return {value: currentValue, label: currentLabel};
            }).filter(opt => opt !== null);
            if (defaultValue === null && element.value && typeof element.value === 'string') {
                const directValueMatch = options.find(opt => opt.value === element.value);
                if (directValueMatch) defaultValue = directValueMatch.value;
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

function collectInputState() {
    const inputs = {};
    uiContainer.querySelectorAll('[data-element-type]').forEach(el => {
        const name = el.name;
        if (!name) return;
        const type = el.dataset.elementType;
        switch (type) {
            case 'textfield': inputs[name] = el.value; break;
            case 'checkbox': inputs[name] = el.checked; break;
            case 'slider': inputs[name] = parseFloat(el.value); break;
            case 'radio': if (el.checked) inputs[name] = el.value; break;
        }
    });
    inputs['turn'] = historyQueue.length + 1;
    return JSON.stringify(inputs);
}

function setLoading(loading) {
    isLoading = loading;
    loadingIndicator.style.display = loading ? 'flex' : 'none';
    submitButton.disabled = loading;
    modeToggleButton.disabled = loading;
    resetGameButton.disabled = loading;
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

function isValidHexColor(hex) { return typeof hex === 'string' && /^#[0-9A-F]{6}$/i.test(hex); }

function adjustColorForContrast(hex) {
    if (!isValidHexColor(hex)) return hex;
    let r = parseInt(hex.substring(1, 3), 16), g = parseInt(hex.substring(3, 5), 16), b = parseInt(hex.substring(5, 7), 16);
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    if (l > MIN_CONTRAST_LIGHTNESS) {
        l = MIN_CONTRAST_LIGHTNESS * 0.9;
        let r1, g1, b1;
        if (s === 0) r1 = g1 = b1 = l; else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1; if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r1 = hue2rgb(p, q, h + 1 / 3); g1 = hue2rgb(p, q, h); b1 = hue2rgb(p, q, h - 1 / 3);
        }
        const toHex = x => { const hexVal = Math.round(x * 255).toString(16); return hexVal.length === 1 ? '0' + hexVal : hexVal; };
        return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
    }
    return hex;
}

function showClipboardMessage(message, isError = false) {
    clipboardMessage.textContent = message;
    clipboardMessage.style.color = isError ? '#dc2626' : '#16a34a';
    setTimeout(() => { clipboardMessage.textContent = ''; }, 3000);
}

function updateModeButtonVisuals() {
    modeToggleButton.textContent = isMasturbationMode ? 'Mode: Explicit' : 'Mode: Standard';
    modeToggleButton.classList.toggle('standard-mode', !isMasturbationMode);
}

function setDynamicImages() {
    const headerSeed = Math.floor(Math.random() * 65536), footerSeed = Math.floor(Math.random() * 65536);
    const headerPrompt = "wide cinematic vivid colorful abstract emotional landscape brainwaves", footerPrompt = "wide abstract colorful digital roots network connections";
    if (headerBanner) headerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(headerPrompt)}?width=1200&height=200&seed=${headerSeed}&nologo=true&safe=false`;
    if (footerBanner) footerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(footerPrompt)}?width=1200&height=100&seed=${footerSeed}&nologo=true&safe=false`;
}

function showAnalysisModal() {
    if (!analysisModal || !analysisModalBody) return;
    if (hiddenAnalysisContent) {
        analysisModalBody.innerHTML = (hiddenAnalysisContentTweet + "\n\n" + hiddenAnalysisContent + "\n\nSystem notes: " + hiddenAnalysisContentNotes)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/```([\s\S]*?)```/g, (match, p1) => `<pre>${p1.trim()}</pre>`).replace(/\n/g, '<br>');
    } else {
        analysisModalBody.innerHTML = '<p>No analysis content available for this turn.</p>';
    }
    analysisModal.style.display = 'block';
}

function hideAnalysisModal() { if (analysisModal) analysisModal.style.display = 'none'; }
function showNotification(message, type = 'info', duration = 4000) { showClipboardMessage(message, type === 'error' || type === 'warn'); }

// --- All Multiplayer functions are included as they were ---
// ... updatePeerListUI, createPeerIcon, handlePeerJoined, etc. ...
function updatePeerListUI(){if(!peerListContainer)return;peerListContainer.innerHTML='';const e=MPLib.getConnections?Array.from(MPLib.getConnections().keys()):[],t=MPLib.getLocalPeerId?MPLib.getLocalPeerId():null,o=MPLib.getHostPeerId?MPLib.getHostPeerId():null,i=null!==localGameStateSnapshot;if(t){const s=createPeerIcon(t,"You",!0,t===o);s.onclick=()=>{i?(console.log("Clicked local icon - restoring local state."),restoreLocalState()):console.log("Clicked local icon - already viewing local state.")},peerListContainer.appendChild(s)}e.forEach(e=>{if(e!==t){const t=MPLib.getConnections().get(e);if(t&&"object"==typeof t&&t.open){const i=e===o,s=createPeerIcon(e,e.slice(-6),!1,i);s.onclick=()=>{console.log(`Clicked remote peer icon: ${e.slice(-6)}`),console.log(`Requesting game state from ${e.slice(-6)}...`),MPLib.sendDirect(e,{type:"request_game_state"}),showNotification(`Requesting state from ${e.slice(-6)}...`,"info",2e3),highlightPeerIcon(e)},peerListContainer.appendChild(s)}else console.log(`Skipping peer icon for ${e.slice(-6)} - connection not fully established or is invalid.`)}i||highlightPeerIcon(null))}
    function createPeerIcon(e,t,o,i){const s=document.createElement("div");s.className="peer-icon-wrapper tooltip",s.dataset.peerId=e;const n=document.createElement("span");n.className="peer-icon",n.style.backgroundColor=o?"#4f46e5":"#71717a",i&&(n.style.borderColor="#facc15",n.style.borderWidth="2px",n.style.borderStyle="solid"),n.textContent=t.slice(-4).toUpperCase();const l=document.createElement("span");return l.className="tooltiptext",l.textContent=`${t}${i?" (Host)":""} - ${e}`,s.appendChild(n),s.appendChild(l),s}
    function highlightPeerIcon(e){if(!peerListContainer)return;peerListContainer.querySelectorAll(".peer-icon-wrapper").forEach(t=>{t.dataset.peerId===e?(t.classList.add("viewing"),e!==MPLib.getLocalPeerId()&&peerListContainer.querySelector(`.peer-icon-wrapper[data-peer-id="${MPLib.getLocalPeerId()}"]`)?.classList.remove("viewing")):t.classList.remove("viewing")}),null===e&&MPLib.getLocalPeerId()&&peerListContainer.querySelector(`.peer-icon-wrapper[data-peer-id="${MPLib.getLocalPeerId()}"]`)?.classList.add("viewing")}
    function addPeerIconStyles(){if(document.getElementById("peer-icon-styles"))return;const e=".peer-list-container{display:flex;gap:.75rem;padding:.5rem 1rem;justify-content:center;align-items:center;background-color:rgba(255,255,255,.1);border-top:1px solid rgba(209,213,219,.5);margin-top:1rem;flex-wrap:wrap}.peer-icon-wrapper{position:relative;display:inline-block}.peer-icon{display:inline-flex;align-items:center;justify-content:center;width:2.5rem;height:2.5rem;border-radius:50%;color:#fff;font-weight:700;font-size:1rem;cursor:pointer;transition:transform .2s ease,box-shadow .2s ease;box-shadow:0 2px 4px rgba(0,0,0,.2);box-sizing:border-box;user-select:none;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none}.peer-icon-wrapper:hover .peer-icon{transform:scale(1.1);box-shadow:0 4px 8px rgba(0,0,0,.3)}.peer-icon-wrapper.viewing .peer-icon{outline:3px solid #a78bfa;outline-offset:2px;box-shadow:0 0 10px rgba(167,139,250,.7)}.tooltip .tooltiptext{visibility:hidden;width:max-content;max-width:200px;background-color:#555;color:#fff;text-align:center;border-radius:6px;padding:5px 8px;position:absolute;z-index:10;bottom:135%;left:50%;transform:translateX(-50%);opacity:0;transition:opacity .3s;font-size:.75rem;word-wrap:break-word;pointer-events:none}.tooltip:hover .tooltiptext{visibility:visible;opacity:1}.tooltip .tooltiptext::after{content:\"\";position:absolute;top:100%;left:50%;margin-left:-5px;border-width:5px;border-style:solid;border-color:#555 transparent transparent transparent}",t=document.createElement("style");t.id="peer-icon-styles",t.type="text/css",t.innerText=e,document.head.appendChild(t)}
    function handlePeerJoined(e,t){console.log(`MPLib Event: Peer joined - ${e.slice(-6)}`),showNotification(`Peer ${e.slice(-6)} connected.`,"success",2e3),updatePeerListUI()}
    function handlePeerLeft(e){console.log(`MPLib Event: Peer left - ${e.slice(-6)}`),showNotification(`Peer ${e.slice(-6)} disconnected.`,"warn",2e3),remoteGameStates.delete(e);const t=null!==localGameStateSnapshot;t&&0===remoteGameStates.size?(console.log(`Peer ${e.slice(-6)} left while being viewed (or was last viewed). Restoring local state.`),restoreLocalState()):updatePeerListUI()}
    function handleDataReceived(e,t){if(console.log(`MPLib Event: Data received from ${e.slice(-6)}`,t),!t||!t.type)return void console.warn("Received data without type from peer:",e.slice(-6));switch(t.type){case"request_game_state":console.log(`Received game state request from ${e.slice(-6)}`),apiKeyLocked&&currentUiJson?(MPLib.sendDirect(e,{type:"game_state",payload:getCurrentGameState()}),console.log(`Sent current game state back to ${e.slice(-6)}`)):(console.log(`Game not started or no UI yet, cannot send state to ${e.slice(-6)}.`),MPLib.sendDirect(e,{type:"game_state_not_ready"}));break;case"game_state":console.log(`Received game state from ${e.slice(-6)}`),t.payload?(remoteGameStates.set(e,t.payload),loadGameState(t.payload,e)):(console.warn("Received game_state message with no payload."),showNotification(`Failed to load state from ${e.slice(-6)}.`,"error",3e3),highlightPeerIcon(null),submitButton.disabled=!1);break;case"game_state_not_ready":console.log(`Received game_state_not_ready from ${e.slice(-6)}`),showNotification(`Peer ${e.slice(-6)}'s game has not started yet.`,"info",3e3),highlightPeerIcon(null),submitButton.disabled=!1;break;case"game_state_update":console.log(`Received game state update broadcast from ${e.slice(-6)}`),t.payload&&(remoteGameStates.set(e,t.payload),peerListContainer?.querySelector(".peer-icon-wrapper.viewing")?.dataset.peerId===e?(console.log(`Auto-refreshing view for peer ${e.slice(-6)}.`),loadGameState(t.payload,e)):showNotification(`Received state update from ${e.slice(-6)}.`,"info",1500));break;default:console.warn(`Received unknown message type '${t.type}' from ${e.slice(-6)}`)}}
    function handleStatusUpdate(e){console.log(`MPLib Status: ${e}`)}
    function handleError(e,t){console.error(`MPLib Error (${e}):`,t)}
    function handleBecameHost(){console.log("This client BECAME THE HOST."),showNotification("You are now the host!","success"),updatePeerListUI()}
    function handleConnectedToHost(e){console.log(`Successfully connected to HOST: ${e}`),showNotification(`Connected to host ${e.slice(-6)}`,"success"),updatePeerListUI()}


// --- Event Listeners ---
    h1.addEventListener('click', () => { showAnalysisModal() });

    submitButton.addEventListener('click', () => {
        console.log("Submit button clicked.");
        initAudioContext();
        const playerActions = collectInputState();
        if (isLoading) return;
        fetchTurnData(playerActions);
    });

    modeToggleButton.addEventListener('click', () => {
        if (isLoading) return;
        isMasturbationMode = !isMasturbationMode;
        console.log(`Mode Toggled: ${isMasturbationMode ? 'Explicit' : 'Standard'}`);
        updateModeButtonVisuals();
        autoSaveGameState();
    });

    resetGameButton.addEventListener('click', () => {
        if (isLoading) return;
        if (confirm('Reset game? This will clear local progress. Are you sure?')) {
            console.log("Resetting game state...");
            historyQueue = [];
            currentUiJson = null;
            currentNotes = {};
            currentSubjectId = "";
            currentModelIndex = 0;
            hiddenAnalysisContent = null;
            localStorage.removeItem(LOCAL_STORAGE_KEY);
            uiContainer.innerHTML = '';
            hideError();
            let currentInitialMessage = document.getElementById('initial-message') || createInitialMessage();
            currentInitialMessage.style.display = 'block';
            currentInitialMessage.innerHTML = 'Click "Submit Turn" to begin the guided experience.';
            setLoading(false);
            updateModeButtonVisuals();
        }
    });

    if (analysisModalClose) { analysisModalClose.addEventListener('click', hideAnalysisModal); }
    if (analysisModal) { analysisModal.addEventListener('click', (event) => { if (event.target === analysisModal) hideAnalysisModal(); }); }

// --- Initial Game Setup ---
    function initializeGame() {
        console.log("Initializing GEEMS (Free API Version)...");

        // The API key section is hidden by default in the HTML/CSS, but we ensure it here.
        if (apiKeySection) apiKeySection.style.display = 'none';
        apiKeyLocked = true; // Game is always ready to start.

        let autoStarted = false;
        const storedStateString = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (storedStateString) {
            console.log("Found saved state. Attempting restore...");
            try {
                const savedState = JSON.parse(storedStateString);
                historyQueue = savedState.historyQueue || [];
                currentUiJson = savedState.currentUiJson || null;
                isMasturbationMode = savedState.isMasturbationMode === true;
                currentModelIndex = savedState.currentModelIndex || 0;
                autoStarted = true;
                console.log("State restored from localStorage.");
                setDynamicImages();
                if (currentUiJson) renderUI(currentUiJson); else throw new Error("Restored state incomplete (missing UI).");
                updateModeButtonVisuals();
                const msg = document.getElementById('initial-message');
                if (msg) msg.style.display = 'none';
                hideError();
            } catch (error) {
                console.error("Error restoring state:", error);
                showError(`Error restoring saved state: ${error.message}. Starting fresh.`);
                localStorage.removeItem(LOCAL_STORAGE_KEY);
                // Fall through to manual start
            }
        }

        if (!autoStarted) {
            console.log("Manual start.");
            historyQueue = [];
            currentUiJson = null;
            isMasturbationMode = false;
            currentModelIndex = 0;
            hiddenAnalysisContent = null;
            uiContainer.innerHTML = '';
            const initialMsg = document.getElementById('initial-message') || createInitialMessage();
            initialMsg.style.display = 'block';
            initialMsg.innerHTML = 'Click "Submit Turn" to begin the guided experience.';
            hideError();
            updateModeButtonVisuals();
            setDynamicImages();
        }

        setLoading(false); // Ensure UI is enabled

        // Initialize Multiplayer
        if (typeof MPLib !== 'undefined' && typeof MPLib.initialize === 'function') {
            console.log("Initializing Multiplayer Library...");
            addPeerIconStyles();
            if (footerElement && !peerListContainer) {
                peerListContainer = document.createElement('div');
                peerListContainer.id = 'peer-list';
                peerListContainer.className = 'peer-list-container';
                const footerContent = footerElement.querySelector('.footer-content');
                footerElement.insertBefore(peerListContainer, footerContent || null);
            }
            MPLib.initialize({
                targetHostId: DEFAULT_HOST_ID, debugLevel: 1,
                onStatusUpdate: handleStatusUpdate, onError: handleError,
                onPeerJoined: handlePeerJoined, onPeerLeft: handlePeerLeft,
                onDataReceived: handleDataReceived, onConnectedToHost: handleConnectedToHost,
                onBecameHost: handleBecameHost,
                getInitialSyncData: () => apiKeyLocked ? getCurrentGameState() : null,
                onInitialSync: (syncData) => {
                    if (syncData) {
                        console.log("Received initial sync data from host.");
                        if (!currentUiJson) {
                            showNotification("Received initial state from host. You can now view their game.", "info", 6000);
                            loadGameState(syncData, MPLib.getHostPeerId());
                        } else {
                            console.log("Already have local game state, ignoring initial sync data.");
                        }
                    } else {
                        console.log("Connected to host, but no initial sync data received.");
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
        msgDiv.className = 'text-center text-gray-500 p-6';
        uiContainer.appendChild(msgDiv);
        return msgDiv;
    }

    document.addEventListener('DOMContentLoaded', initializeGame);

    setInterval(() => {
        // This logic seems intended for a demo mode. Keeping it, but it will click your own icon if you're the only one.
        if (apiKeyInput && apiKeyInput.value.trim().length === 0 && peerListContainer) {
            const peerIcons = Array.from(peerListContainer.querySelectorAll('.peer-icon-wrapper'));
            if (peerIcons.length > 0) {
                const randomPeerIcon = peerIcons[Math.floor(Math.random() * peerIcons.length)];
                if (randomPeerIcon) randomPeerIcon.click();
            }
        }
    }, 10000);
}