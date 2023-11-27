const CONFIG = {
    INPUT_UP_ID: 0,
    INPUT_DOWN_ID: 1,
    DISABLE_AP_AFTER_SECS: 5 * 60, // 5 mins
};

// times in milliseconds
const T = {
    MOTION: 20 * 1000,
    HOLD_PERM: 2 * 1000,
    AUTO_CLOSE: 3 * 60 * 1000,
    CLOSE_WARNING: 10 * 1000,
    PERM_FLASH: 500,
    UNLOCK: 2 * 1000,
}

const UP = JSON.stringify(CONFIG.INPUT_UP_ID);
const DOWN = JSON.stringify(CONFIG.INPUT_DOWN_ID);

const Motion = {
    Up: 'Up',
    Down: 'Down',
    None: 'None',
};

const State = {
    Locked: {
        name: 'Locked',
        motion: Motion.None,
    },
    GoingDown: {
        name: 'GoingDown',
        motion: Motion.Down,
        timer: {
            time: T.MOTION,
            target: 'Locked',
        },
    },
    Stopped: {
        name: 'Stopped',
        motion: Motion.None,
        timer: {
            time: T.AUTO_CLOSE,
            target: 'GoingDown',
        },
    },
    GoingUp: {
        name: 'GoingUp',
        motion: Motion.Up,
        timer: {
            time: T.MOTION,
            target: 'Up',
        },
    },
    Up: {
        name: 'Up',
        motion: Motion.Up,
        timer: {
            time: T.AUTO_CLOSE,
            target: 'WarnDown',
        },
    },
    UpPermInit: {
        name: 'UpPermInit',
        motion: Motion.None,
        timer: {
            time: T.PERM_FLASH,
            target: 'UpPerm',
        },
    },
    UpPerm: {
        name: 'UpPerm',
        motion: Motion.Up,
    },
    WarnDown: {
        name: 'WarnDown',
        motion: Motion.None,
        timer: {
            time: T.CLOSE_WARNING,
            target: 'GoingDown',
        },
    },
};

const Event = {
    UpPressed: 'UpPressed',
    DownPressed: 'DownPressed',
    UpReleased: 'UpReleased',
    DownReleased: 'DownReleased',
};

const INIT_STATE = State.GoingDown;

let current_motion = Motion.None;
let current_state = State.Stopped;
let state_change_timer = undefined;
let hold_perm_timer = undefined;
let locked_num_up_pressed = 0;


// Sets the output `id_str` to state `set_on`.
let set_output = function (id_str, set_on) {
    Shelly.call("switch.set", {
        id: id_str,
        on: set_on,
    });
}

// Sets the outputs to `motion` which can be `Up`, `Down` or `None`.
// 
// The implementation makes sure that at most one output is active at a time.
// For example, when switching from `Up` to `Down`, the `Up` output is deactivated
// first and the `Down` output is activated afterwards.
let set_motion = function (motion) {
    // early return if nothing needs to be changed
    if (current_motion == motion) {
        return;
    }
    
    // if we're currently moving up / down, stop
    if (current_motion == Motion.Up) {
        set_output(UP, false);
    } else if (current_motion == Motion.Down) {
        set_output(DOWN, false);
    }

    // at this point, both outputs are off

    // set the right output motion
    if (motion == Motion.Up) {
        set_output(UP, true);
    } else if (motion == Motion.Down) {
        set_output(DOWN, true);
    }
    
    current_motion = motion;
}

// Sets a new state and updates the outputs accordingly
let set_state = function (state) {
    print("State: " + state.name);
    
    if ('timer' in current_state) {
        Timer.clear(state_change_timer);
    }
    if ('exit' in current_state) {
        current_state.exit();
    }
    current_state = state;
    if ('enter' in current_state) {
        current_state.enter();
    }
    if ('timer' in current_state) {
        state_change_timer = Timer.set(current_state.timer.time, false, function() { set_state(State[current_state.timer.target]) });
    }
    set_motion(state.motion)
}

let update = function (event) {
    if (current_state === State.Locked) {
        if (event === Event.UpPressed) {
            if (locked_num_up_pressed == 0) {
                locked_num_up_pressed += 1;
                Timer.set(T.UNLOCK, false, function() { locked_num_up_pressed = 0; });
            } else {
                locked_num_up_pressed = 0;
                set_state(State.GoingUp);
            }
        }
    } else if (current_state === State.Stopped) {
        if (event === Event.UpPressed) {
            set_state(State.GoingUp);
        } else if (event === Event.DownPressed) {
            set_state(State.GoingDown);
        }
    } else if (current_state === State.GoingDown) {
        if (event === Event.UpPressed) {
            set_state(State.Stopped);
        }
    } else if (current_state === State.GoingUp) {
        if (event === Event.DownPressed) {
            set_state(State.Stopped);
        }
    } else if (current_state === State.Up) {
        if (event === Event.UpPressed) {
            // set timer to detect long press
            hold_perm_timer = Timer.set(T.HOLD_PERM, false, function() { 
                if (current_state === State.Up) { set_state(State.UpPermInit); } 
            });
            // reset timer by entering the Up state again
            set_state(State.Up);
        } else if (event === Event.DownPressed) {
            set_state(State.GoingDown);
        } else if (event === Event.UpReleased) {
            Timer.clear(hold_perm_timer);
        }
    } else if (current_state === State.WarnDown) {
        if (event === Event.UpPressed) {
            set_state(State.Up);
        } else if (event === Event.DownPressed) {
            set_state(State.GoingDown);
        }
    } else if (current_state === State.UpPermInit) {
        // intentionally left empty
    } else if (current_state === State.UpPerm) {
        if (event === Event.DownPressed) {
            set_state(State.GoingDown);
        }
    }
}

let disable_ap = function () {
    print("Disabling AP");
    Shelly.call(
        "Wifi.SetConfig",
        { config: { ap: { enable: false } } },
        function () { }
    );
};

let setup = function () {
    print("Setup");
    
    // set initial state
    set_state(INIT_STATE);
    
    // setup auto-disabling of AP
    Shelly.call(
        "Wifi.SetConfig",
        { config: { ap: { enable: true } } },
        function (result, err_code, err_msg, user) {
            if (err_code === 0) {
                print("Will disable wifi after DISABLE_AP_AFTER_SECS seconds.");
                Timer.set(CONFIG.DISABLE_AP_AFTER_SECS * 1000, false, disable_ap, null);
            }
        }
    );

    // set up input event handlers
    Shelly.call(
        "switch.setconfig",
        { id: JSON.stringify(CONFIG.INPUT_ID), config: { in_mode: "detached" } },
        function () {
            // print("Adding event handler");
            Shelly.addEventHandler(function (event) {
                if (!(event.info.event === "toggle")) {
                    return;
                }
                if (event.component === "input:" + JSON.stringify(CONFIG.INPUT_UP_ID)) {
                    update(event.info.state === true ? Event.UpPressed : Event.UpReleased);
                }
                if (event.component === "input:" + JSON.stringify(CONFIG.INPUT_DOWN_ID)) {
                    update(event.info.state === true ? Event.DownPressed : Event.DownReleased);
                }
            }, null);
        }
    );
};

setup();