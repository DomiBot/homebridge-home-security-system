const fs = require("fs");
const path = require("path");
const storage = require("node-persist");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const express = require("express");
const rateLimit = require("express-rate-limit");

const packageJson = require("../package.json");
const options = require("./utils/options.js");

const originTypes = {
  REGULAR_SWITCH: 0,
  SPECIAL_SWITCH: 1,
  INTERNAL: 3,
  EXTERNAL: 4,
};

const app = express();
let Service, Characteristic, storagePath;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  storagePath = homebridge.user.storagePath();

  homebridge.registerAccessory(
    "homebridge-home-security-system",
    "home-security-system",
    HomeSecuritySystem
  );
};

function HomeSecuritySystem(log, config) {
  this.log = log;
  options.init(log, config);

  this.defaultState = this.mode2State(options.defaultMode);
  this.currentState = this.defaultState;
  this.targetState = this.defaultState;
  this.availableTargetStates = null;

  this.isArming = false;
  this.isKnocked = false;

  this.invalidCodeCount = 0;

  this.pausedCurrentState = null;
  this.audioProcess = null;

  this.armTimeout = null;
  this.pauseTimeout = null;
  this.triggerTimeout = null;
  this.doubleKnockTimeout = null;
  this.resetTimeout = null;

  this.sirenTrippedInterval = null;
  this.sirenTriggeredInterval = null;

  // File logger
  if (options.isValueSet(options.logDirectory)) {
    const logInfo = this.log.info.bind(this.log);
    const logWarn = this.log.warn.bind(this.log);
    const logError = this.log.error.bind(this.log);

    this.log.info = (message) => {
      logInfo.apply(null, [message]);
      this.log.appendFile(message);
    };

    this.log.warn = (message) => {
      logWarn.apply(null, [message]);
      this.log.appendFile(message);
    };

    this.log.error = (message) => {
      logError.apply(null, [message]);
      this.log.appendFile(message);
    };

    this.log.appendFile = async (message) => {
      const date = new Date();

      try {
        const stats = await fs.promises.stat(
          `${options.logDirectory}/securitysystem.log`
        );

        if (
          stats.birthtime.toLocaleDateString() !== date.toLocaleDateString()
        ) {
          await fs.promises.rename(
            `${options.logDirectory}/securitysystem.log`,
            `${options.logDirectory}/securitysystem-${stats.birthtime
              .toLocaleDateString()
              .replaceAll("/", "-")}.log`
          );
        }
      } catch (error) {
        this.log.debug("Previous log file not found.");
      }

      try {
        await fs.promises.appendFile(
          `${options.logDirectory}/securitysystem.log`,
          `[${new Date().toLocaleString()}] ${message}\n`,
          { flag: "a" }
        );
      } catch (error) {
        logError("File logger (Error)");
        logError(error);
      }
    };
  }

  // Log
  if (options.testMode) {
    this.log.warn("Test Mode");
  }

  this.logMode("Default", this.defaultState);
  this.log.info(`Arm delay (${options.armSeconds} second/s)`);
  this.log.info(`Trigger delay (${options.triggerSeconds} second/s)`);
  this.log.info(`Audio (${options.audio ? "Enabled" : "Disabled"})`);

  if (options.proxyMode) {
    this.log.info("Proxy mode (Enabled)");
  }

  if (options.isValueSet(options.webhookUrl)) {
    this.log.info(`Webhook (${options.webhookUrl})`);
  }

  // Security system
  this.service = new Service.SecuritySystem(options.name);
  this.availableTargetStates = this.getAvailableTargetStates();

  this.service.getCharacteristic(
    Characteristic.SecuritySystemTargetState
  ).value = this.targetState;

  this.service
    .getCharacteristic(Characteristic.SecuritySystemTargetState)
    .setProps({ validValues: this.availableTargetStates })
    .on("get", this.getTargetState.bind(this))
    .on("set", this.setTargetState.bind(this));

  this.service.getCharacteristic(
    Characteristic.SecuritySystemCurrentState
  ).value = this.currentState;

  this.service
    .getCharacteristic(Characteristic.SecuritySystemCurrentState)
    .on("get", this.getCurrentState.bind(this));

  // Siren switches
  this.sirenSwitchService = new Service.Switch("Siren", "siren-switch");

  this.sirenSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getSirenSwitch.bind(this))
    .on("set", this.setSirenSwitch.bind(this));
	
  this.sirenOverrideSwitchService = new Service.Switch(
    "Siren Override",
    "BdW9ce0mUYatqiRqEjT4iA"
  );

  this.sirenOverrideSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getSirenOverrideSwitch.bind(this))
    .on("set", this.setSirenOverrideSwitch.bind(this));

  this.sirenHomeSwitchService = new Service.Switch("Siren Home", "siren-home");

  this.sirenHomeSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getSirenHomeSwitch.bind(this))
    .on("set", this.setSirenHomeSwitch.bind(this));

  this.sirenAwaySwitchService = new Service.Switch("Siren Away", "siren-away");

  this.sirenAwaySwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getSirenAwaySwitch.bind(this))
    .on("set", this.setSirenAwaySwitch.bind(this));

  this.sirenNightSwitchService = new Service.Switch(
    "Siren Night",
    "siren-night"
  );

  this.sirenNightSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getSirenNightSwitch.bind(this))
    .on("set", this.setSirenNightSwitch.bind(this));

  // Arming lock switches
  this.armingLockSwitchService = new Service.Switch(
    "Arming Lock",
    "arming-lock"
  );

  this.armingLockSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getArmingLockSwitch.bind(this))
    .on("set", this.setArmingLockSwitch.bind(this));

  this.armingLockHomeSwitchService = new Service.Switch(
    "Arming Lock Home",
    "arming-lock-home"
  );

  this.armingLockHomeSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getArmingLockHomeSwitch.bind(this))
    .on("set", this.setArmingLockHomeSwitch.bind(this));

  this.armingLockAwaySwitchService = new Service.Switch(
    "Arming Lock Away",
    "arming-lock-away"
  );

  this.armingLockAwaySwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getArmingLockAwaySwitch.bind(this))
    .on("set", this.setArmingLockAwaySwitch.bind(this));

  this.armingLockNightSwitchService = new Service.Switch(
    "Arming Lock Night",
    "arming-lock-night"
  );

  this.armingLockNightSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getArmingLockNightSwitch.bind(this))
    .on("set", this.setArmingLockNightSwitch.bind(this));

  // Mode switches
  this.modeHomeSwitchService = new Service.Switch("Mode Home", "mode-home");

  this.modeHomeSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getModeHomeSwitch.bind(this))
    .on("set", this.setModeHomeSwitch.bind(this));

  this.modeAwaySwitchService = new Service.Switch("Mode Away", "mode-away");

  this.modeAwaySwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getModeAwaySwitch.bind(this))
    .on("set", this.setModeAwaySwitch.bind(this));

  this.modeNightSwitchService = new Service.Switch("Mode Night", "mode-night");

  this.modeNightSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getModeNightSwitch.bind(this))
    .on("set", this.setModeNightSwitch.bind(this));

  this.modeOffSwitchService = new Service.Switch("Mode Off", "mode-off");

  this.modeOffSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getModeOffSwitch.bind(this))
    .on("set", this.setModeOffSwitch.bind(this));

  this.modeAwayExtendedSwitchService = new Service.Switch(
    "Mode Away Extended",
    "mode-away-extended"
  );

  this.modeAwayExtendedSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getModeAwayExtendedSwitch.bind(this))
    .on("set", this.setModeAwayExtendedSwitch.bind(this));

  this.modePauseSwitchService = new Service.Switch("Mode Pause", "mode-pause");

  this.modePauseSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getModePauseSwitch.bind(this))
    .on("set", this.setModePauseSwitch.bind(this));

  // Audio switch
  this.audioSwitchService = new Service.Switch(
    "Audio",
    "kx82r64zN3txDXKFiX9JDi"
  );

  this.audioSwitchService
    .getCharacteristic(Characteristic.On)
    .on("get", this.getAudioSwitch.bind(this))
    .on("set", this.setAudioSwitch.bind(this));

  this.audioSwitchService.getCharacteristic(Characteristic.On).value = true;

  // Siren sensors
  this.sirenTrippedMotionSensorService = new Service.MotionSensor(
    "Siren Tripped",
    "siren-tripped"
  );

  this.sirenTrippedMotionSensorService
    .getCharacteristic(Characteristic.MotionDetected)
    .on("get", this.getSirenTrippedMotionDetected.bind(this));

  this.sirenTriggeredMotionSensorService = new Service.MotionSensor(
    "Siren Triggered",
    "siren-triggered"
  );

  this.sirenTriggeredMotionSensorService
    .getCharacteristic(Characteristic.MotionDetected)
    .on("get", this.getSirenTriggeredMotionDetected.bind(this));

  this.sirenResetMotionSensorService = new Service.MotionSensor(
    "Siren Reset",
    "reset-event"
  );

  this.sirenResetMotionSensorService
    .getCharacteristic(Characteristic.MotionDetected)
    .on("get", this.getSirenResetMotionDetected.bind(this));

  // Accessory information
  this.accessoryInformationService = new Service.AccessoryInformation();

  this.accessoryInformationService.setCharacteristic(
    Characteristic.Identify,
    true
  );
  this.accessoryInformationService.setCharacteristic(
    Characteristic.Manufacturer,
    "Domi"
  );
  this.accessoryInformationService.setCharacteristic(
    Characteristic.Model,
    "DIY"
  );
  this.accessoryInformationService.setCharacteristic(
    Characteristic.Name,
    "homebridge-securitysystem"
  );
  this.accessoryInformationService.setCharacteristic(
    Characteristic.SerialNumber,
    "S3CUR1TYSYST3M"
  );
  this.accessoryInformationService.setCharacteristic(
    Characteristic.FirmwareRevision,
    packageJson.version
  );

  // Services list
  this.services = [this.service, this.accessoryInformationService];

  if (options.trippedSensor) {
    this.services.push(this.sirenTrippedMotionSensorService);
  }

  if (options.sirenSensor) {
    this.services.push(this.sirenTriggeredMotionSensorService);
  }

  if (options.resetSensor) {
    this.services.push(this.sirenResetMotionSensorService);
  }

  if (options.armingLockSwitch) {
    this.services.push(this.armingLockSwitchService);
  }

  if (options.armingLockSwitches) {
    this.services.push(this.armingLockHomeSwitchService);
    this.services.push(this.armingLockAwaySwitchService);
    this.services.push(this.armingLockNightSwitchService);
  }

  if (options.sirenSwitch) {
    this.services.push(this.sirenSwitchService);
  }
  
  
  if(options.zones){
	  this.zoned = options.zones.length || 0
	  this.contactSensorService = []
	  for (let zone = 1; zone <= this.zoned; zone++) {
		  this.contactSensorService[zone] = new Service.ContactSensor(options.zones[zone - 1].zonename, "sensor" + zone);

		  this.contactSensorService[zone]
			.getCharacteristic(Characteristic.ContactSensorState)
			//.on("get", this.getSirenSwitch.bind(this))
		  
		  this.services.push(this.contactSensorService[zone])
		  setInterval(() => {
			  fetch("http://192.168.2.47:8080/" + options.zones[zone - 1].token + "/get/V" + options.zones[zone - 1].zonepin)
				.then((response) => response.json())
				.then((data) =>  {  
					this.contactSensorService[zone].updateCharacteristic(Characteristic.ContactSensorState, data[0])
					if(this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState).value === 1){
						if(data[0] == 1){
							this.sirenSwitchService.setCharacteristic(Characteristic.On, data[0])
						}
					}
				})
				.catch((error) => {
				  this.log.error(`Request to webhook failed. (${path})`);
				  this.log.error(error);
				});
			}, 1000);
	  }
  }

  if (options.sirenOverrideSwitch) {
    this.services.push(this.sirenOverrideSwitchService);
  }

  if (
    this.availableTargetStates.includes(
      Characteristic.SecuritySystemTargetState.STAY_ARM
    )
  ) {
    if (options.modeSwitches) {
      this.services.push(this.modeHomeSwitchService);
    }

    if (options.sirenModeSwitches) {
      this.services.push(this.sirenHomeSwitchService);
    }
  }

  if (
    this.availableTargetStates.includes(
      Characteristic.SecuritySystemTargetState.AWAY_ARM
    )
  ) {
    if (options.modeSwitches) {
      this.services.push(this.modeAwaySwitchService);
    }

    if (options.sirenModeSwitches) {
      this.services.push(this.sirenAwaySwitchService);
    }
  }

  if (
    this.availableTargetStates.includes(
      Characteristic.SecuritySystemTargetState.NIGHT_ARM
    )
  ) {
    if (options.modeSwitches) {
      this.services.push(this.modeNightSwitchService);
    }

    if (options.sirenModeSwitches) {
      this.services.push(this.sirenNightSwitchService);
    }
  }

  if (options.modeSwitches && options.modeOffSwitch) {
    this.services.push(this.modeOffSwitchService);
  }

  if (options.modeAwayExtendedSwitch) {
    this.services.push(this.modeAwayExtendedSwitchService);
  }

  if (options.modePauseSwitch) {
    this.services.push(this.modePauseSwitchService);
  }

  if (options.audio && options.audioSwitch) {
    this.services.push(this.audioSwitchService);
  }

  // Storage
  if (options.saveState) {
    this.load();
  }

  // Audio
  if (options.isValueSet(options.audioPath)) {
    this.setupAudio();
  }

  // Server
  if (options.isValueSet(options.serverPort)) {
    this.startServer();
  }
}

HomeSecuritySystem.prototype.getServices = function () {
  return this.services;
};

HomeSecuritySystem.prototype.load = async function () {
  const storageOptions = {
    dir: path.join(storagePath, "homebridge-securitysystem"),
  };

  await storage
    .init(storageOptions)
    .then()
    .catch((error) => {
      this.log.error("Unable to load state.");
      this.log.error(error);
    });

  if (options.testMode) {
    await storage.clear();
    this.log.debug("Saved data from the plugin cleared.");

    return;
  }

  await storage
    .getItem("state")
    .then((state) => {
      if (state === undefined) {
        return;
      }

      this.log.debug("State (Loaded)", state);
      this.log.info("Saved state (Found)");

      const currentState = options.isValueSet(state.currentState)
        ? state.currentState
        : this.defaultState;
      const targetState = options.isValueSet(state.targetState)
        ? state.targetState
        : this.defaultState;

      // Change target state if triggered
      if (
        currentState ===
        Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED
      ) {
        this.targetState = targetState;
      } else {
        this.targetState = currentState;
      }

      this.currentState = currentState;

      // Update characteristics values
      this.service.updateCharacteristic(
        Characteristic.SecuritySystemTargetState,
        this.targetState
      );
      this.service.updateCharacteristic(
        Characteristic.SecuritySystemCurrentState,
        this.currentState
      );
      this.handleStateUpdate(false);

      // Log
      this.logMode("Current", this.currentState);
    })
    .catch((error) => {
      this.log.error("Saved state (Error)");
      this.log.error(error);
    });
};

HomeSecuritySystem.prototype.save = async function () {
  // Check option
  if (options.saveState === false) {
    return;
  }

  if (storage.defaultInstance === undefined) {
    this.log.error("Unable to save state.");
    return;
  }

  const state = {
    currentState: this.currentState,
    targetState: this.targetState,
  };

  await storage
    .setItem("state", state)
    .then(() => {
      this.log.debug("State (Saved)", state);
    })
    .catch((error) => {
      this.log.error("Unable to save state.");
      this.log.error(error);
    });
};

HomeSecuritySystem.prototype.identify = function (callback) {
  this.log("Identify");
  callback(null);
};

// Security system
HomeSecuritySystem.prototype.state2Mode = function (state) {
  switch (state) {
    case Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED:
      return "triggered";

    case Characteristic.SecuritySystemCurrentState.STAY_ARM:
      return "home";

    case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
      return "away";

    case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
      return "night";

    case Characteristic.SecuritySystemCurrentState.DISARMED:
      return "off";

    // Custom
    case "lock":
      // Audio sound
      return state;

    case "warning":
      return state;

    default:
      this.log.error(`Unknown state (${state}).`);
      return "unknown";
  }
};

HomeSecuritySystem.prototype.mode2State = function (mode) {
  switch (mode) {
    case "home":
      return Characteristic.SecuritySystemCurrentState.STAY_ARM;

    case "away":
      return Characteristic.SecuritySystemCurrentState.AWAY_ARM;

    case "night":
      return Characteristic.SecuritySystemCurrentState.NIGHT_ARM;

    case "off":
      return Characteristic.SecuritySystemCurrentState.DISARMED;

    default:
      this.log.error(`Unknown mode (${mode}).`);
      return -1;
  }
};

HomeSecuritySystem.prototype.logMode = function (type, state) {
  let mode = this.state2Mode(state);
  mode = mode.charAt(0).toUpperCase() + mode.slice(1);

  this.log.info(`${type} mode (${mode})`);
};

HomeSecuritySystem.prototype.getAvailableTargetStates = function () {
  const targetStateCharacteristic = this.service.getCharacteristic(
    Characteristic.SecuritySystemTargetState
  );
  const validValues = targetStateCharacteristic.props.validValues;
  const invalidValues = options.disabledModes.map((value) => {
    return this.mode2State(value.toLowerCase());
  });

  return validValues.filter((state) => invalidValues.includes(state) === false);
};

HomeSecuritySystem.prototype.getCurrentState = function (callback) {
  callback(null, this.currentState);
};

HomeSecuritySystem.prototype.setCurrentState = function (state, origin) {
  // Check if mode already set
  if (this.currentState === state) {
    return;
  }

  this.currentState = state;
  this.service.setCharacteristic(
    Characteristic.SecuritySystemCurrentState,
    state
  );
  this.logMode("Current", state);

  // Audio
  this.playAudio("current", state);

  // Commands
  this.executeCommand("current", state, origin);

  // Webhooks
  this.sendWebhookEvent("current", state, origin);

  if (state === Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED) {
    // Update siren triggered sensor
    this.sirenTriggeredInterval = setInterval(() => {
      this.updateSirenTriggeredMotionDetected();
    }, options.sirenSensorSeconds * 1000);

    // Automatically arm the security system
    // when time runs out
    this.resetTimeout = setTimeout(() => {
      this.resetTimeout = null;
      this.log.info("Reset (Finished)");

      // Update reset sensor
      this.sirenResetMotionSensorService.updateCharacteristic(
        Characteristic.MotionDetected,
        true
      );

      setTimeout(() => {
        this.sirenResetMotionSensorService.updateCharacteristic(
          Characteristic.MotionDetected,
          false
        );
      }, 750);

      // Alternative flow (Triggered -> Off -> Armed mode)
      if (options.resetOffFlow) {
        const originalTargetState = this.targetState;
        this.updateTargetState(
          Characteristic.SecuritySystemTargetState.DISARM,
          originTypes.INTERNAL,
          false,
          null
        );

        setTimeout(() => {
          this.updateTargetState(
            originalTargetState,
            originTypes.INTERNAL,
            true,
            null
          );
        }, 100);

        return;
      }

      // Normal flow
      this.handleStateUpdate(false);
      this.setCurrentState(this.targetState, false);
    }, options.resetMinutes * 60 * 1000);
  }

  this.save();
};

HomeSecuritySystem.prototype.resetTimers = function () {
  // Clear trigger timeout
  if (this.triggerTimeout !== null) {
    clearTimeout(this.triggerTimeout);

    this.triggerTimeout = null;
    this.log.debug("Trigger timeout (Cleared)");
  }

  // Clear arming timeout
  if (this.armTimeout !== null) {
    clearTimeout(this.armTimeout);

    this.armTimeout = null;
    this.log.debug("Arming timeout (Cleared)");
  }

  // Clear siren triggered sensor
  if (this.sirenTriggeredInterval !== null) {
    clearInterval(this.sirenTriggeredInterval);

    this.sirenTriggeredInterval = null;
    this.log.debug("Siren triggered interval (Cleared)");
  }

  // Clear siren tripped sensor
  if (this.sirenTrippedInterval !== null) {
    clearInterval(this.sirenTrippedInterval);

    this.sirenTrippedInterval = null;
    this.log.debug("Siren tripped interval (Cleared)");
  }

  // Clear double-knock timeout
  if (this.doubleKnockTimeout !== null) {
    clearTimeout(this.doubleKnockTimeout);
    this.doubleKnockTimeout = null;

    this.log.debug("Double-knock timeout (Cleared)");
  }

  // Clear pause timeout
  if (this.pauseTimeout !== null) {
    clearTimeout(this.pauseTimeout);
    this.pauseTimeout = null;

    this.log.debug("Pause timeout (Cleared)");
  }

  // Clear security system reset timeout
  if (this.resetTimeout !== null) {
    clearTimeout(this.resetTimeout);

    this.resetTimeout = null;
    this.log.debug("Reset timeout (Cleared)");
  }
};

HomeSecuritySystem.prototype.handleStateUpdate = function (alarmTriggered) {
  // Reset double-knock
  this.isKnocked = false;

  this.resetTimers();
  this.resetModeSwitches();
  this.updateModeSwitches();

  // Keep characteristic & switches on
  if (alarmTriggered) {
    return;
  }

  const sirenOnCharacteristic = this.sirenSwitchService.getCharacteristic(
    Characteristic.On
  );

  if (sirenOnCharacteristic.value) {
    this.updateSiren(false, originTypes.INTERNAL, true, null);
  }

  this.resetSirenSwitches();
};

HomeSecuritySystem.prototype.updateTargetState = function (
  state,
  origin,
  delay,
  callback
) {
  const isTargetStateAlreadySet = this.targetState === state;
  const isCurrentStateAlarmTriggered =
    this.currentState ===
    Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
  const isTargetStateDisarm =
    state === Characteristic.SecuritySystemTargetState.DISARM;

  // Check if target state is already set
  if (isTargetStateAlreadySet && isCurrentStateAlarmTriggered === false) {
    this.log.warn("Target mode (Already set)");

    if (callback !== null) {
      callback(null);
    }

    return false;
  }

  // Check if state is enabled
  if (this.availableTargetStates.includes(state) === false) {
    this.log.warn("Target mode (Disabled)");

    if (callback !== null) {
      // Tip: this will revert the original state
      callback(Characteristic.SecuritySystemTargetState.DISARM);
    }

    return false;
  }

  // Check arming lock switches
  const isArmingLockEnabled =
    options.isValueSet(options.armingLockSwitch) ||
    options.isValueSet(options.armingLockSwitches);

  if (
    isTargetStateDisarm === false &&
    isArmingLockEnabled &&
    this.isArmingLocked(state)
  ) {
    this.log.warn("Arming lock (Not allowed)");

    if (callback !== null) {
      // Tip: this will revert the original state
      callback(Characteristic.SecuritySystemTargetState.DISARM);
    }

    return false;
  }

  // Update target state
  this.targetState = state;
  this.logMode("Target", state);

  const isTargetStateHome =
    this.targetState === Characteristic.SecuritySystemTargetState.STAY_ARM;
  const isTargetStateAway =
    this.targetState === Characteristic.SecuritySystemTargetState.AWAY_ARM;
  const isTargetStateNight =
    this.targetState === Characteristic.SecuritySystemTargetState.NIGHT_ARM;

  // Update characteristic
  if (origin === originTypes.INTERNAL || origin === originTypes.EXTERNAL) {
    this.service.updateCharacteristic(
      Characteristic.SecuritySystemTargetState,
      this.targetState
    );
  }

  // Reset everything
  this.handleStateUpdate(false);

  // Commands
  this.executeCommand("target", state, origin);

  // Webhooks
  this.sendWebhookEvent("target", state, origin);

  // Check if current state is already set
  if (state === this.currentState) {
    this.log.warn("Current mode (Already set)");

    // Play audio
    this.playAudio("current", this.currentState);

    if (callback !== null) {
      callback(null);
    }

    return false;
  }

  // Set arming delay
  let armSeconds = 0;

  if (delay) {
    armSeconds = options.armSeconds;

    // No delay when triggered or set to Off
    if (isCurrentStateAlarmTriggered || isTargetStateDisarm) {
      armSeconds = 0;
    }

    // Custom mode seconds
    if (isTargetStateHome && options.isValueSet(options.homeArmSeconds)) {
      armSeconds = options.homeArmSeconds;
    } else if (
      isTargetStateAway &&
      options.isValueSet(options.awayArmSeconds)
    ) {
      armSeconds = options.awayArmSeconds;
    } else if (
      isTargetStateNight &&
      options.isValueSet(options.nightArmSeconds)
    ) {
      armSeconds = options.nightArmSeconds;
    }

    // Delay actions
    if (armSeconds > 0) {
      this.isArming = true;

      // Play sound
      this.playAudio("target", state);
    }
  }

  // Arm the security system
  this.armTimeout = setTimeout(() => {
    this.armTimeout = null;
    this.setCurrentState(state, origin);
    this.isArming = false;
  }, armSeconds * 1000);

  if (callback !== null) {
    callback(null);
  }

  return true;
};

HomeSecuritySystem.prototype.getTargetState = function (callback) {
  callback(null, this.targetState);
};

HomeSecuritySystem.prototype.setTargetState = function (value, callback) {
	this.updateTargetState(value, originTypes.REGULAR_SWITCH, true, callback);
};

HomeSecuritySystem.prototype.updateSiren = function (
  value,
  origin,
  stateChanged,
  callback
) {
  const isCurrentStateAlarmTriggered =
    this.currentState ===
    Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
  const isCurrentStateHome =
    this.currentState === Characteristic.SecuritySystemCurrentState.STAY_ARM;
  const isCurrentStateAway =
    this.currentState === Characteristic.SecuritySystemCurrentState.AWAY_ARM;
  const isCurrentStateNight =
    this.currentState === Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
  const isCurrentStateDisarmed =
    this.currentState === Characteristic.SecuritySystemCurrentState.DISARMED;

  // Check if the security system is disarmed
  const isNotOverridingOff = options.overrideOff === false;
  const isNotSpecialSwitch = origin !== originTypes.SPECIAL_SWITCH;

  if (isCurrentStateDisarmed && isNotOverridingOff && isNotSpecialSwitch) {
    this.log.warn("Siren Switch (Not armed)");

    if (callback !== null) {
      callback(-70412, false);
    }

    return false;
  }

  // Check if arming
  if (this.isArming) {
    this.log.warn("Siren Switch (Still arming)");

    if (callback !== null) {
      callback(-70412, false);
    }

    return false;
  }

  // Check double knock
  if (options.doubleKnock) {
    const doubleKnockStates = options.doubleKnockModes.map((value) => {
      return this.mode2State(value.toLowerCase());
    });

    const isFirstKnock = this.isKnocked === false;
    const isSpecialSwitch = origin === originTypes.SPECIAL_SWITCH;
    const isStateKnockable = doubleKnockStates.includes(this.currentState);

    if (
      value &&
      isStateKnockable &&
      isFirstKnock &&
      isSpecialSwitch === false
    ) {
      this.log.warn("Siren Switch (Knock)");
      this.isKnocked = true;

      // Custom mode seconds
      let doubleKnockSeconds = options.doubleKnockSeconds;

      if (
        isCurrentStateHome &&
        options.isValueSet(options.homeDoubleKnockSeconds)
      ) {
        doubleKnockSeconds = options.homeDoubleKnockSeconds;
      } else if (
        isCurrentStateAway &&
        options.isValueSet(options.awayDoubleKnockSeconds)
      ) {
        doubleKnockSeconds = options.awayDoubleKnockSeconds;
      } else if (
        isCurrentStateNight &&
        options.isValueSet(options.nightDoubleKnockSeconds)
      ) {
        doubleKnockSeconds = options.nightDoubleKnockSeconds;
      }

      this.doubleKnockTimeout = setTimeout(() => {
        this.doubleKnockTimeout = null;
        this.isKnocked = false;

        this.log.info("Siren Switch (Reset)");
      }, doubleKnockSeconds * 1000);

      if (callback !== null) {
        callback(-70412, false);
      }

      return false;
    }
  }

  // Clear double-knock timeout
  if (this.doubleKnockTimeout !== null) {
    clearTimeout(this.doubleKnockTimeout);
    this.doubleKnockTimeout = null;

    this.log.debug("Double-knock timeout (Cleared)");
  }

  if (origin === originTypes.INTERNAL || origin === originTypes.EXTERNAL) {
    this.sirenSwitchService.updateCharacteristic(Characteristic.On, value);
  }

  if (value) {
    // Already triggered
    if (isCurrentStateAlarmTriggered) {
      this.log.warn("Siren Switch (Already triggered)");

      if (callback !== null) {
        callback(-70412, false);
      }

      return false;
    }

    // Already about to trigger
    if (this.triggerTimeout !== null) {
      this.log.warn("Siren Switch (Already on)");

      if (callback !== null) {
        callback(-70412, false);
      }

      return false;
    }

    this.log.info("Siren Switch (On)");

    // Update siren tripped sensor
    if (options.trippedSensor) {
      this.updateSirenTrippedMotionDetected();

      this.sirenTrippedInterval = setInterval(() => {
        this.updateSirenTrippedMotionDetected();
      }, options.trippedSensorSeconds * 1000);
    }

    const isCurrentStateHome =
      this.currentState === Characteristic.SecuritySystemCurrentState.STAY_ARM;
    const isCurrentStateAway =
      this.currentState === Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    const isCurrentStateNight =
      this.currentState === Characteristic.SecuritySystemCurrentState.NIGHT_ARM;

    // Set trigger delay
    let triggerSeconds = options.triggerSeconds;

    // User options
    if (isCurrentStateHome && options.isValueSet(options.homeTriggerSeconds)) {
      triggerSeconds = options.homeTriggerSeconds;
    }

    if (isCurrentStateAway) {
      const modeAwayExtendedSwitchCharacteristicOn =
        this.modeAwayExtendedSwitchService.getCharacteristic(Characteristic.On);
      const modeAwayExtendedSwitchCharacteristicOnValue =
        modeAwayExtendedSwitchCharacteristicOn.value;

      if (
        options.isValueSet(options.awayExtendedTriggerSeconds) &&
        modeAwayExtendedSwitchCharacteristicOnValue
      ) {
        triggerSeconds = options.awayExtendedTriggerSeconds;
      } else if (options.isValueSet(options.awayTriggerSeconds)) {
        triggerSeconds = options.awayTriggerSeconds;
      }
    }

    if (
      isCurrentStateNight &&
      options.isValueSet(options.nightTriggerSeconds)
    ) {
      triggerSeconds = options.nightTriggerSeconds;
    }

    this.triggerTimeout = setTimeout(() => {
      this.triggerTimeout = null;
      this.setCurrentState(
        Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED,
        origin
      );
    }, triggerSeconds * 1000);

    // Audio
    if (triggerSeconds > 0) {
      this.playAudio("current", "warning");
    }

    // Commands
    this.executeCommand("current", "warning", origin);

    // Webhooks
    this.sendWebhookEvent("current", "warning", origin);
  } else {
    // Off
    this.log.info("Siren Switch (Off)");
    this.stopAudio();

    if (isCurrentStateAlarmTriggered) {
      if (stateChanged === false) {
        this.updateTargetState(
          Characteristic.SecuritySystemTargetState.DISARM,
          originTypes.INTERNAL,
          false,
          null
        );
      }
    } else {
      this.resetTimers();
    }

    // Update siren tripped sensor
    if (options.trippedSensor) {
      this.sirenTrippedMotionSensorService.updateCharacteristic(
        Characteristic.MotionDetected,
        false
      );
    }

    this.isKnocked = false;
  }

  if (callback !== null) {
    callback(null);
  }

  return true;
};

HomeSecuritySystem.prototype.setSiren = function (value, callback) {
  this.updateSiren(value, originTypes.REGULAR_SWITCH, false, callback);
};

// Server
HomeSecuritySystem.prototype.isAuthenticated = function (req, res) {
  // Check if authentication is disabled
  if (options.serverCode === null) {
    return null;
  }

  let code = req.query.code;

  // Check if code sent
  if (code === undefined) {
    this.sendCodeRequiredError(res);
    return false;
  }

  // Check brute force
  if (this.invalidCodeCount >= 5) {
    req.blocked = true;
    this.sendCodeInvalidError(req, res);
    return false;
  }

  const userCode = parseInt(req.query.code);

  if (userCode !== options.serverCode) {
    this.invalidCodeCount++;
    this.sendCodeInvalidError(req, res);
    return false;
  }

  // Reset
  this.invalidCodeCount = 0;

  return true;
};

HomeSecuritySystem.prototype.getDelayParameter = function (req) {
  return req.query.delay === "true" ? true : false;
};

HomeSecuritySystem.prototype.sendCodeRequiredError = function (res) {
  this.log.info("Code required (Server)");

  const response = {
    error: true,
    message: "Code required",
    hint: "Add the 'code' URL parameter with your security code",
  };

  res.status(401).json(response);
};

HomeSecuritySystem.prototype.sendCodeInvalidError = function (req, res) {
  const response = { error: true };

  if (req.blocked) {
    this.log.info("Code blocked (Server)");
    response.message = "Code blocked";
  } else {
    this.log.info("Code invalid (Server)");
    response.message = "Code invalid";
  }

  res.status(403).json(response);
};

HomeSecuritySystem.prototype.sendResultResponse = function (res, sucess) {
  const response = {
    error: sucess ? false : true,
  };

  res.json(response);
};

HomeSecuritySystem.prototype.startServer = async function () {
  const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use(apiLimiter);

  app.get("/", (req, res) => {
    res.redirect(
      "https://github.com/MiguelRipoll23/homebridge-securitysystem/wiki/Server"
    );
  });

  app.get("/status", (req, res) => {
    if (this.isAuthenticated(req, res) === false) {
      return;
    }

    const response = {
      arming: this.isArming,
      current_mode: this.state2Mode(this.currentState),
      target_mode: this.state2Mode(this.targetState),
      sensor_triggered: this.triggerTimeout !== null,
      arming_lock: this.isArmingLocked("global"),
    };

    res.json(response);
  });

  app.get("/triggered", (req, res) => {
    if (this.isAuthenticated(req, res) === false) {
      return;
    }

    let result = true;

    if (this.getDelayParameter(req)) {
      // Delay
      result = this.updateSiren(true, originTypes.EXTERNAL, false, null);
    } else {
      const isCurrentStateDisarmed =
        this.currentState ===
        Characteristic.SecuritySystemCurrentState.DISARMED;

      // Not armed
      if (isCurrentStateDisarmed && options.overrideOff === false) {
        this.sendResultResponse(res, false);
        return;
      }

      this.handleStateUpdate(true);
      this.setCurrentState(
        Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED,
        true
      );
    }

    this.sendResultResponse(res, result);
  });

  app.get("/home", (req, res) => {
    if (this.isAuthenticated(req, res) === false) {
      return;
    }

    const state = Characteristic.SecuritySystemTargetState.STAY_ARM;
    const delay = this.getDelayParameter(req);
    const result = this.updateTargetState(
      state,
      originTypes.EXTERNAL,
      delay,
      null
    );

    this.sendResultResponse(res, result);
  });

  app.get("/away", (req, res) => {
    if (this.isAuthenticated(req, res) === false) {
      return;
    }

    const state = Characteristic.SecuritySystemTargetState.AWAY_ARM;
    const delay = this.getDelayParameter(req);
    const result = this.updateTargetState(
      state,
      originTypes.EXTERNAL,
      delay,
      null
    );

    this.sendResultResponse(res, result);
  });

  app.get("/night", (req, res) => {
    if (this.isAuthenticated(req, res) === false) {
      return;
    }

    const state = Characteristic.SecuritySystemTargetState.NIGHT_ARM;
    const delay = this.getDelayParameter(req);
    const result = this.updateTargetState(
      state,
      originTypes.EXTERNAL,
      delay,
      null
    );

    this.sendResultResponse(res, result);
  });

  app.get("/off", (req, res) => {
    if (this.isAuthenticated(req, res) === false) {
      return;
    }

    const state = Characteristic.SecuritySystemTargetState.DISARM;
    const delay = this.getDelayParameter(req);
    const result = this.updateTargetState(
      state,
      originTypes.EXTERNAL,
      delay,
      null
    );

    this.sendResultResponse(res, result);
  });

  app.get("/arming-lock/:mode/:value", (req, res) => {
    if (this.isAuthenticated(req, res) === false) {
      return;
    }

    const mode = req.params["mode"].toLowerCase();
    const value = req.params["value"].includes("on");
    const result = this.updateArmingLock(mode, value);

    this.sendResultResponse(res, result);
  });

  // Listener
  const server = app.listen(options.serverPort, (error) => {
    if (error) {
      this.log.error("Error while starting server.");
      this.log.error(error);
      return;
    }

    this.log.info(`Server (${options.serverPort})`);
  });

  server.on("error", (error) => {
    this.log.error("Error while starting server.");
    this.log.error(error);
  });
};

// Audio
HomeSecuritySystem.prototype.playAudio = async function (type, state) {
  // Check option
  if (options.audio === false) {
    return;
  }

  const mode = this.state2Mode(state);

  // Close previous player
  this.stopAudio();

  // Ignore 'Current Off' event
  if (mode === "off") {
    if (type === "target") {
      return;
    }
  }

  // Check audio switch except for triggered
  const audioSwitchOnCharacteristic = this.audioSwitchService.getCharacteristic(
    Characteristic.On
  );
  const isAudioDisabledBySwitch = audioSwitchOnCharacteristic.value === false;

  if (mode !== "triggered" && isAudioDisabledBySwitch) {
    return;
  }

  // Directory
  let directory = `${__dirname}/../sounds`;

  if (options.isValueSet(options.audioPath)) {
    directory = options.audioPath;

    if (directory[directory.length] === "/") {
      directory = directory.substring(0, directory.length - 1);
    }
  }

  // Check if file exists
  const filename = `${type}-${mode}.mp3`;
  const filePath = `${directory}/${options.audioLanguage}/${filename}`;
  
  try {
    await fs.promises.access(filePath);
  } catch (error) {
    this.log(`Sound file not found (${filePath})`);
    return;
  }

  // Arguments
  let commandArguments = ["-loglevel", "error", "-nodisp", "-i", `${filePath}`];

  if (mode === "triggered") {
    commandArguments.push("-loop");
    commandArguments.push("-1");
  } else if (
    (mode === "home" || mode === "night" || mode === "away") &&
    type === "target" &&
    options.audioArmingLooped
  ) {
    commandArguments.push("-loop");
    commandArguments.push("-1");
  } else if (mode === "warning" && options.audioAlertLooped) {
    commandArguments.push("-loop");
    commandArguments.push("-1");
  } else {
    commandArguments.push("-autoexit");
  }

  if (options.isValueSet(options.audioVolume)) {
    commandArguments.push("-volume");
    commandArguments.push(options.audioVolume);
  }

  // Process
  const environmentVariables = [process.env];

  options.audioExtraVariables.forEach((variable) => {
    const key = variable.key;
    const value = variable.value;
    environmentVariables[key] = value;
  });

  this.log.debug("Environment Variables (Audio)", environmentVariables);

  const ffplayEnv = {
    ...process.env,
    ...environmentVariables,
  };

  this.audioProcess = spawn("ffplay", commandArguments, { env: ffplayEnv });
  this.log.debug(`ffplay ${commandArguments.join(" ")}`);

  this.audioProcess.on("error", (data) => {
    // Check if command is missing
    if (data !== null && data.toString().indexOf("ENOENT") > -1) {
      this.log.error("Unable to play sound, ffmpeg is not installed.");
      return;
    }

    this.log.error(`Unable to play sound.\n${data}`);
  });
  
  this.audioProcess.on("close", function () {
    this.audioProcess = null;
  });
};

HomeSecuritySystem.prototype.stopAudio = function () {
  if (this.audioProcess !== null) {
    this.audioProcess.kill();
  }
};

HomeSecuritySystem.prototype.setupAudio = async function () {
  try {
    await fs.promises.access(`${options.audioPath}/${options.audioLanguage}`);
  } catch (error) {
    await fs.promises.mkdir(`${options.audioPath}/${options.audioLanguage}`);
    await fs.promises.copyFile(
      `${__dirname}/sounds/README`,
      `${options.audioPath}/README`
    );
    await fs.promises.copyFile(
      `${__dirname}/sounds/README`,
      `${options.audioPath}/README.txt`
    );

    this.log.warn("Check audio path directory for instructions.");
  }
};

// Command
HomeSecuritySystem.prototype.executeCommand = function (type, state, origin) {
  // Check proxy mode
  if (options.proxyMode && origin === originTypes.EXTERNAL) {
    this.log.debug("Command bypassed as proxy mode is enabled.");
    return;
  }

  let command = null;

  switch (state) {
    case Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED:
      command = options.commandCurrentTriggered;
      break;

    case Characteristic.SecuritySystemCurrentState.STAY_ARM:
      if (type === "current") {
        command = options.commandCurrentHome;
        break;
      }

      command = options.commandTargetHome;
      break;

    case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
      if (type === "current") {
        command = options.commandCurrentAway;
        break;
      }

      command = options.commandTargetAway;
      break;

    case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
      if (type === "current") {
        command = options.commandCurrentNight;
        break;
      }

      command = options.commandTargetNight;
      break;

    case Characteristic.SecuritySystemCurrentState.DISARMED:
      if (type === "current") {
        command = options.commandCurrentOff;
        break;
      }

      command = options.commandTargetOff;
      break;

    case "warning":
      command = options.commandCurrentWarning;
      break;

    default:
      this.log.error(`Unknown command ${type} state (${state})`);
  }

  if (command === undefined || command === null) {
    this.log.debug(`Command option for ${type} mode is not set.`);
    return;
  }

  // Parameters
  command = command.replace(
    "${currentMode}",
    this.state2Mode(this.currentState)
  );

  const process = spawn(command, { shell: true });

  process.stderr.on("data", (data) => {
    this.log.error(`Command failed (${command})\n${data}`);
  });

  process.stdout.on("data", (data) => {
    this.log.info(`Command output: ${data}`);
  });
};

// Webhooks
HomeSecuritySystem.prototype.sendWebhookEvent = function (type, state, origin) {
  // Check webhook host
  if (options.isValueSet(options.webhookUrl) === false) {
    this.log.debug("Webhook base URL option is not set.");
    return;
  }

  // Check proxy mode
  if (options.proxyMode && origin === originTypes.EXTERNAL) {
    this.log.debug("Webhook bypassed as proxy mode is enabled.");
    return;
  }

  let path = null;

  switch (state) {
    case Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED:
      path = options.webhookCurrentTriggered;
      break;

    case Characteristic.SecuritySystemCurrentState.STAY_ARM:
      if (type === "current") {
        path = options.webhookCurrentHome;
        break;
      }

      path = options.webhookTargetHome;
      break;

    case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
      if (type === "current") {
        path = options.webhookCurrentAway;
        break;
      }

      path = options.webhookTargetAway;
      break;

    case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
      if (type === "current") {
        path = options.webhookCurrentNight;
        break;
      }

      path = options.webhookTargetNight;
      break;

    case Characteristic.SecuritySystemCurrentState.DISARMED:
      if (type === "current") {
        path = options.webhookCurrentOff;
        break;
      }

      path = options.webhookTargetOff;
      break;

    case "warning":
      path = options.webhookCurrentWarning;
      break;

    default:
      this.log.error(`Unknown webhook ${type} state (${state})`);
      return;
  }

  if (path === undefined || path === null) {
    this.log.debug(`Webhook option for ${type} mode is not set.`);
    return;
  }

  // Parameters
  path = path.replace("${currentMode}", this.state2Mode(this.currentState));

  // Send GET request to server
  fetch(options.webhookUrl + state)
    .then((response) => {
      if (response.ok === false) {
        throw new Error(`Status code (${response.status})`);
      }

      this.log.info("Webhook event (Sent)");
    })
    .catch((error) => {
      this.log.error(`Request to webhook failed. (${path})`);
      this.log.error(error);
    });
};

// Siren switches
HomeSecuritySystem.prototype.getSirenSwitch = function (callback) {
  const value = this.sirenSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setSirenSwitch = function (value, callback) {
  this.updateSiren(value, originTypes.REGULAR_SWITCH, false, callback);
};

HomeSecuritySystem.prototype.getSirenOverrideSwitch = function (callback) {
  const value = this.sirenOverrideSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setSirenOverrideSwitch = function (value, callback) {
  this.updateSiren(value, originTypes.SPECIAL_SWITCH, false, callback);
};

HomeSecuritySystem.prototype.resetSirenSwitches = function () {
  const sirenHomeOnCharacteristic =
    this.sirenHomeSwitchService.getCharacteristic(Characteristic.On);
  const sirenAwayOnCharacteristic =
    this.sirenAwaySwitchService.getCharacteristic(Characteristic.On);
  const sirenNightOnCharacteristic =
    this.sirenNightSwitchService.getCharacteristic(Characteristic.On);

  const sirenOverrideOnCharacteristic =
    this.sirenOverrideSwitchService.getCharacteristic(Characteristic.On);

  if (sirenHomeOnCharacteristic.value) {
    sirenHomeOnCharacteristic.updateValue(false);
    this.log.debug("Siren Home Switch (Off)");
  }

  if (sirenAwayOnCharacteristic.value) {
    sirenAwayOnCharacteristic.updateValue(false);
    this.log.debug("Siren Away Switch (Off)");
  }

  if (sirenNightOnCharacteristic.value) {
    sirenNightOnCharacteristic.updateValue(false);
    this.log.debug("Siren Night Switch (Off)");
  }

  if (sirenOverrideOnCharacteristic.value) {
    sirenOverrideOnCharacteristic.updateValue(false);
    this.log.debug("Siren Override Switch (Off)");
  }
};

HomeSecuritySystem.prototype.triggerIfModeSet = function (
  switchRequiredState,
  value,
  callback
) {
  const isCurrentStateAlarmTriggered =
    this.currentState ===
    Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;

  if (value) {
    if (
      this.currentState === switchRequiredState ||
      (this.targetState === switchRequiredState && isCurrentStateAlarmTriggered)
    ) {
      this.updateSiren(value, originTypes.REGULAR_SWITCH, false, callback);
    } else {
      this.log.debug("Siren (Mode switch not set)");
      callback(-70412, false);
    }
  } else {
    this.updateSiren(value, originTypes.REGULAR_SWITCH, false, callback);
  }
};

HomeSecuritySystem.prototype.getSirenHomeSwitch = function (callback) {
  const value = this.sirenHomeSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setSirenHomeSwitch = function (value, callback) {
  this.log.debug("Siren Home Switch (On)");
  this.triggerIfModeSet(
    Characteristic.SecuritySystemCurrentState.STAY_ARM,
    value,
    callback
  );
};

HomeSecuritySystem.prototype.getSirenAwaySwitch = function (callback) {
  const value = this.sirenAwaySwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setSirenAwaySwitch = function (value, callback) {
  this.log.debug("Siren Away Switch (On)");
  this.triggerIfModeSet(
    Characteristic.SecuritySystemCurrentState.AWAY_ARM,
    value,
    callback
  );
};

HomeSecuritySystem.prototype.getSirenNightSwitch = function (callback) {
  const value = this.sirenNightSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setSirenNightSwitch = function (value, callback) {
  this.log.debug("Siren Night Switch (On)");
  this.triggerIfModeSet(
    Characteristic.SecuritySystemCurrentState.NIGHT_ARM,
    value,
    callback
  );
};

// Arming lock switches
HomeSecuritySystem.prototype.getArmingLockSwitch = function (callback) {
  const value = this.armingLockSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.getArmingLockHomeSwitch = function (callback) {
  const value = this.armingLockHomeSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.getArmingLockAwaySwitch = function (callback) {
  const value = this.armingLockAwaySwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.getArmingLockNightSwitch = function (callback) {
  const value = this.armingLockNightSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.logArmingLock = function (mode, value) {
  const modeCapitalized = mode.charAt(0).toUpperCase() + mode.slice(1);
  this.log.info(`Arming lock [${modeCapitalized}] (${value ? "On" : "Off"})`);
};

HomeSecuritySystem.prototype.isArmingLocked = function (state) {
  let armingLockSwitchService = this.armingLockSwitchService;

  // Check global switch
  if (armingLockSwitchService.getCharacteristic(Characteristic.On).value) {
    return true;
  }

  // Check mode switches
  switch (state) {
    case "global":
      // Server status endpoint
      return false;

    case Characteristic.SecuritySystemCurrentState.STAY_ARM:
      armingLockSwitchService = this.armingLockHomeSwitchService;
      break;

    case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
      armingLockSwitchService = this.armingLockAwaySwitchService;
      break;

    case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
      armingLockSwitchService = this.armingLockNightSwitchService;
      break;

    default:
      this.log.debug(`Unknown arming lock state (${state})`);
  }

  return armingLockSwitchService.getCharacteristic(Characteristic.On).value;
};

HomeSecuritySystem.prototype.updateArmingLock = function (mode, value) {
  this.logArmingLock(mode, value);

  switch (mode) {
    case "global":
      this.armingLockSwitchService
        .getCharacteristic(Characteristic.On)
        .updateValue(value);
      break;

    case "home":
      this.armingLockHomeSwitchService
        .getCharacteristic(Characteristic.On)
        .updateValue(value);
      break;

    case "away":
      this.armingLockAwaySwitchService
        .getCharacteristic(Characteristic.On)
        .updateValue(value);
      break;

    case "night":
      this.armingLockNightSwitchService
        .getCharacteristic(Characteristic.On)
        .updateValue(value);
      break;

    default:
      this.log.debug(`Unknown arming lock mode (${mode})`);
      return false;
  }

  return true;
};

HomeSecuritySystem.prototype.setArmingLockSwitch = function (value, callback) {
  this.logArmingLock("global", value);
  callback(null);
};

HomeSecuritySystem.prototype.setArmingLockHomeSwitch = function (value, callback) {
  this.logArmingLock("home", value);
  callback(null);
};

HomeSecuritySystem.prototype.setArmingLockAwaySwitch = function (value, callback) {
  this.logArmingLock("away", value);
  callback(null);
};

HomeSecuritySystem.prototype.setArmingLockNightSwitch = function (value, callback) {
  this.logArmingLock("night", value);
  callback(null);
};

// Mode Switches
HomeSecuritySystem.prototype.resetModeSwitches = function () {
  const modeHomeSwitchCharacteristicOn =
    this.modeHomeSwitchService.getCharacteristic(Characteristic.On);
  const modeAwaySwitchCharacteristicOn =
    this.modeAwaySwitchService.getCharacteristic(Characteristic.On);
  const modeNightSwitchCharacteristicOn =
    this.modeNightSwitchService.getCharacteristic(Characteristic.On);
  const modeOffSwitchCharacteristicOn =
    this.modeOffSwitchService.getCharacteristic(Characteristic.On);
  const modeAwayExtendedSwitchCharacteristicOn =
    this.modeAwayExtendedSwitchService.getCharacteristic(Characteristic.On);
  const modePauseSwitchCharacteristicOn =
    this.modePauseSwitchService.getCharacteristic(Characteristic.On);

  if (modeHomeSwitchCharacteristicOn.value) {
    modeHomeSwitchCharacteristicOn.updateValue(false);
    this.log.debug("Mode Home Switch (Off)");
  }

  if (modeAwaySwitchCharacteristicOn.value) {
    modeAwaySwitchCharacteristicOn.updateValue(false);
    this.log.debug("Mode Away Switch (Off)");
  }

  if (modeNightSwitchCharacteristicOn.value) {
    modeNightSwitchCharacteristicOn.updateValue(false);
    this.log.debug("Mode Night Switch (Off)");
  }

  if (modeOffSwitchCharacteristicOn.value) {
    modeOffSwitchCharacteristicOn.updateValue(false);
    this.log.debug("Mode Off Switch (Off)");
  }

  if (modeAwayExtendedSwitchCharacteristicOn.value) {
    modeAwayExtendedSwitchCharacteristicOn.updateValue(false);
    this.log.debug("Mode Away Extended Switch (Off)");
  }

  if (modePauseSwitchCharacteristicOn.value) {
    modePauseSwitchCharacteristicOn.updateValue(false);
    this.log.debug("Mode Pause Switch (Off)");
  }
};

HomeSecuritySystem.prototype.updateModeSwitches = function () {
  switch (this.targetState) {
    case Characteristic.SecuritySystemTargetState.STAY_ARM:
      this.modeHomeSwitchService.updateCharacteristic(Characteristic.On, true);
      this.log.debug("Mode Home Switch (On)");
      break;

    case Characteristic.SecuritySystemTargetState.AWAY_ARM:
      this.modeAwaySwitchService.updateCharacteristic(Characteristic.On, true);
      this.log.debug("Mode Away Switch (On)");
      break;

    case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
      this.modeNightSwitchService.updateCharacteristic(Characteristic.On, true);
      this.log.debug("Mode Night Switch (On)");
      break;

    case Characteristic.SecuritySystemTargetState.DISARM:
      this.modeOffSwitchService.updateCharacteristic(Characteristic.On, true);
      this.log.debug("Mode Off Switch (On)");
      break;
  }
};

HomeSecuritySystem.prototype.getModeHomeSwitch = function (callback) {
  const value = this.modeHomeSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setModeHomeSwitch = function (value, callback) {
  if (value === false) {
    callback(-70412, false);
    return;
  }

  this.updateTargetState(
    Characteristic.SecuritySystemTargetState.STAY_ARM,
    originTypes.INTERNAL,
    true,
    null
  );
  callback(null);
};

HomeSecuritySystem.prototype.getModeAwaySwitch = function (callback) {
  const value = this.modeAwaySwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setModeAwaySwitch = function (value, callback) {
  if (value === false) {
    callback(-70412, false);
    return;
  }

  this.updateTargetState(
    Characteristic.SecuritySystemTargetState.AWAY_ARM,
    originTypes.INTERNAL,
    true,
    null
  );
  callback(null);
};

HomeSecuritySystem.prototype.getModeNightSwitch = function (callback) {
  const value = this.modeNightSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setModeNightSwitch = function (value, callback) {
  if (value === false) {
    callback(-70412, false);
    return;
  }

  this.updateTargetState(
    Characteristic.SecuritySystemTargetState.NIGHT_ARM,
    originTypes.INTERNAL,
    true,
    null
  );
  callback(null);
};

HomeSecuritySystem.prototype.getModeOffSwitch = function (callback) {
  const value = this.modeOffSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setModeOffSwitch = function (value, callback) {
  if (value === false) {
    callback(-70412, false);
    return;
  }

  this.updateTargetState(
    Characteristic.SecuritySystemTargetState.DISARM,
    originTypes.INTERNAL,
    true,
    null
  );
  callback(null);
};

HomeSecuritySystem.prototype.getModeAwayExtendedSwitch = function (callback) {
  const value = this.modeAwayExtendedSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setModeAwayExtendedSwitch = function (
  value,
  callback
) {
  if (value === false) {
    callback(-70412, false);
    return;
  }

  this.updateTargetState(
    Characteristic.SecuritySystemTargetState.AWAY_ARM,
    originTypes.INTERNAL,
    true,
    null
  );
  callback(null);
};

HomeSecuritySystem.prototype.getModePauseSwitch = function (callback) {
  const value = this.modePauseSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setModePauseSwitch = function (value, callback) {
  if (
    this.currentState ===
    Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED
  ) {
    this.log.warn("Mode pause (Alarm is triggered)");
    callback(-70412, false);
    return;
  }

  if (value) {
    if (
      this.currentState === Characteristic.SecuritySystemCurrentState.DISARMED
    ) {
      this.log.warn("Mode pause (Not armed)");
      callback(-70412, false);
      return;
    }

    this.log.info("Mode pause (Started)");

    this.pausedCurrentState = this.currentState;
    this.updateTargetState(
      Characteristic.SecuritySystemTargetState.DISARM,
      originTypes.INTERNAL,
      true,
      null
    );

    // Check if time is set to unlimited
    if (options.pauseMinutes !== 0) {
      this.pauseTimeout = setTimeout(() => {
        this.log.info("Mode pause (Finished)");
        this.updateTargetState(
          this.pausedCurrentState,
          originTypes.INTERNAL,
          true,
          null
        );
      }, options.pauseMinutes * 60 * 1000);
    }
  } else {
    this.log.info("Mode pause (Cancelled)");

    if (this.pauseTimeout !== null) {
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = null;
    }

    this.updateTargetState(
      this.pausedCurrentState,
      originTypes.INTERNAL,
      true,
      null
    );
  }

  callback(null);
};

HomeSecuritySystem.prototype.getAudioSwitch = function (callback) {
  const value = this.audioSwitchService.getCharacteristic(
    Characteristic.On
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.setAudioSwitch = function (value, callback) {
  this.log.info(`Audio (${value ? "Enabled" : "Disabled"})`);
  callback(null);
};

// Siren Tripped Motion Sensor
HomeSecuritySystem.prototype.getSirenTrippedMotionDetected = function (callback) {
  const value = this.sirenTrippedMotionSensorService.getCharacteristic(
    Characteristic.MotionDetected
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.updateSirenTrippedMotionDetected = function () {
  this.sirenTrippedMotionSensorService.updateCharacteristic(
    Characteristic.MotionDetected,
    true
  );

  setTimeout(() => {
    this.sirenTrippedMotionSensorService.updateCharacteristic(
      Characteristic.MotionDetected,
      false
    );
  }, 750);
};

// Siren Triggered Motion Sensor
HomeSecuritySystem.prototype.getSirenTriggeredMotionDetected = function (callback) {
  const value = this.sirenTriggeredMotionSensorService.getCharacteristic(
    Characteristic.MotionDetected
  ).value;
  callback(null, value);
};

HomeSecuritySystem.prototype.updateSirenTriggeredMotionDetected = function () {
  this.sirenTriggeredMotionSensorService.updateCharacteristic(
    Characteristic.MotionDetected,
    true
  );

  setTimeout(() => {
    this.sirenTriggeredMotionSensorService.updateCharacteristic(
      Characteristic.MotionDetected,
      false
    );
  }, 750);
};

// Siren Reset Motion Sensor
HomeSecuritySystem.prototype.getSirenResetMotionDetected = function (callback) {
  const value = this.sirenResetMotionSensorService.getCharacteristic(
    Characteristic.MotionDetected
  ).value;
  callback(null, value);
};
