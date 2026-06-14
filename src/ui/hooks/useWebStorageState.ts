/*
   Copyright 2026 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
import { useState, useCallback } from "react";
import equal from "fast-deep-equal";

export function useLocalStorageState<T>(key: string, initState: T): [T, (newState: T) => void] {
    key = "mirakurun:state:" + key;

    const [stored, setStored] = useState<T>();

    if (stored === undefined) {
        const storedState = localStorage.getItem(key);
        if (storedState !== null) {
            initState = JSON.parse(storedState) as T;
        }

        setStored(initState);

        // debug
        console.debug("hooks", "useLocalStorageState()", "get", key, initState);
    }

    const [state, setState] = useState(initState);

    const setStorageState = useCallback((newState: T) => {
        if (equal(newState, state)) {
            return;
        }

        if (newState === undefined) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, JSON.stringify(newState));
        }

        setState(newState);
        setStored(newState);

        // debug
        console.debug("hooks", "useLocalStorageState()", "set", key, newState);
    }, [state]);

    return [state, setStorageState];
}

export function useSessionStorageState<T>(key: string, initState: T): [T, (newState: T) => void] {
    key = "mirakurun:state:" + key;

    const [stored, setStored] = useState<T>();

    if (stored === undefined) {
        const storedState = sessionStorage.getItem(key);
        if (storedState !== null) {
            initState = JSON.parse(storedState) as T;
        }

        setStored(initState);

        // debug
        console.debug("hooks", "useSessionStorageState()", "get", key, initState);
    }

    const [state, setState] = useState(initState);

    const setStorageState = useCallback((newState: T) => {
        if (equal(newState, state)) {
            return;
        }

        if (newState === undefined) {
            sessionStorage.removeItem(key);
        } else {
            sessionStorage.setItem(key, JSON.stringify(newState));
        }

        setState(newState);
        setStored(newState);

        // debug
        console.debug("hooks", "useSessionStorageState()", "set", key, newState);
    }, [state]);

    return [state, setStorageState];
}
