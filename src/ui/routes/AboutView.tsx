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
import * as React from "react";
import { useState, useEffect } from "react";
import { Alignment, Breadcrumbs, Button, Card, Divider, Elevation, H3, H5, Navbar, Text } from "@blueprintjs/core";
import { state } from "../modules/state";
import * as ui from "../modules/ui";
import { VersionStatus } from "../components/VersionStatus";

import "./AboutView.sass";

export const AboutView: React.FC = () => {
    console.debug("routes", "AboutView");

    ui.setTitle("Mirakurun について");

    const [version, setVersion] = useState<string>(state.version);
    useEffect(() => {
        const onVersion = () => {
            setVersion(state.version);
        };
        state.on("version", onVersion);
        return () => {
            state.off("version", onVersion);
        };
    }, []);

    const [consented, setConsented] = useState<boolean>(false);

    const toolbar = (
        <Navbar className="toolbar">
            <Navbar.Group align={Alignment.START}>
                <Navbar.Heading>
                    <Breadcrumbs items={[
                        {
                            text: "Mirakurun について"
                        }
                    ]} />
                </Navbar.Heading>
            </Navbar.Group>
        </Navbar>
    );

    return (
        <div className="route" id="route-about-view">
            {toolbar}

            <div className="content">
                <div className="about-container">
                    <Card elevation={Elevation.ONE} className="about-card">
                        <div className="about-header">
                            <img className="product-icon" src={state.statusIconSrc} alt={state.statusName} />
                            <H3>Mirakurun</H3>
                        </div>

                        <Divider />

                        <div className="about-info">
                            <table className="bp5-html-table bp5-html-table-striped bp5-html-table-condensed info-table">
                                <tbody>
                                    <tr>
                                        <td>Current</td>
                                        <td>{version}</td>
                                    </tr>
                                    <tr>
                                        <td>Latest</td>
                                        <td><VersionStatus /></td>
                                    </tr>
                                    <tr>
                                        <td>License</td>
                                        <td>Apache License 2.0</td>
                                    </tr>
                                    <tr>
                                        <td>Copyright</td>
                                        <td>Copyright &copy; 2016-2026 <a href="https://github.com/kanreisa" target="_blank" rel="noreferrer">kanreisa</a></td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div className="warranty-warning">
                            <Text className="warranty-text">
                                Mirakurun comes with ABSOLUTELY NO WARRANTY. USE AT YOUR OWN RISK.
                            </Text>
                        </div>

                        <div className="links">
                            <Button
                                icon="git-branch"
                                text="GitHub Repository"
                                onClick={() => window.open("https://github.com/Chinachu/Mirakurun", "_blank")}
                                variant="minimal"
                            />
                            <Button
                                icon="globe"
                                text="Chinachu Project"
                                onClick={() => window.open("https://chinachu.moe/", "_blank")}
                                variant="minimal"
                            />
                        </div>
                    </Card>

                    <Card elevation={Elevation.ONE} className="heart-card">
                        <H5>Special Thanks</H5>
                        {consented === false ? (
                            <div className="consent">
                                <p>We sincerely thank you for your continued support.</p>
                                <p>
                                    This page is attempting to retrieve images from your browser by going directly to{" "}
                                    <a href="https://opencollective.com/" target="_blank" rel="noreferrer">
                                        opencollective.com
                                    </a>{" "}
                                    in order to display a list of contributors.
                                </p>
                                <Button
                                    intent="primary"
                                    text="Continue"
                                    onClick={() => setConsented(true)}
                                />
                            </div>
                        ) : (
                            <div className="contributors-list">
                                <div className="section">
                                    <H5>Contributors</H5>
                                    <p>This project exists thanks to all the people who contribute.</p>
                                    <div className="image-container">
                                        <a href="https://github.com/Chinachu/Mirakurun/graphs/contributors" target="_blank" rel="noreferrer">
                                            <img src="https://opencollective.com/Mirakurun/contributors.svg?width=890&button=false" alt="Contributors" className="opencollective-img" />
                                        </a>
                                    </div>
                                </div>

                                <Divider />

                                <div className="section">
                                    <H5>
                                        Backers{" "}
                                        <span className="bp5-text-muted text-small">
                                            [<a href="https://opencollective.com/Mirakurun#backer" target="_blank" rel="noreferrer">Become a backer</a>]
                                        </span>
                                    </H5>
                                    <p>Thank you to all our backers! 🙏</p>
                                    <div className="image-container">
                                        <a href="https://opencollective.com/Mirakurun#backers" target="_blank" rel="noreferrer">
                                            <img src="https://opencollective.com/Mirakurun/backers.svg?width=890" alt="Backers" className="opencollective-img" />
                                        </a>
                                    </div>
                                </div>

                                <Divider />

                                <div className="section">
                                    <H5>
                                        Sponsors{" "}
                                        <span className="bp5-text-muted text-small">
                                            [<a href="https://opencollective.com/Mirakurun#sponsor" target="_blank" rel="noreferrer">Become a sponsor</a>]
                                        </span>
                                    </H5>
                                    <p>Support this project by becoming a sponsor. Your logo will show up here with a link to your website.</p>
                                    <div className="sponsors-avatars">
                                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                                            <a key={i} href={`https://opencollective.com/Mirakurun/sponsor/${i}/website`} target="_blank" rel="noreferrer">
                                                <img src={`https://opencollective.com/Mirakurun/sponsor/${i}/avatar.svg`} alt={`Sponsor ${i}`} className="sponsor-avatar" />
                                            </a>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </Card>
                </div>
            </div>
        </div>
    );
};
