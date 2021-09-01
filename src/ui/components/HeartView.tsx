/*
   Copyright 2021 kanreisa

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
import { useState } from "react";
import {
    Stack,
    Separator,
    Text,
    Link,
    PrimaryButton
} from "@fluentui/react";
import "./HeartView.css";

const HeartView: React.FC = () => {

    const [consented, setConsented] = useState<boolean>(false);

    return (
        <Stack tokens={{ childrenGap: "16 0" }} style={{ margin: "16px 0 8px" }} className="heart-view">
            {consented === false && <>
                <Separator alignContent="start">Confirmation</Separator>

                <div className="consent">
                    <b>We sincerely thank you for your continued support.</b><br />
                    <br />
                    This page is attempting to retrieve images from your browser
                    by going directly to
                    &nbsp;<Link href="https://opencollective.com/" target="_blank">opencollective.com</Link>&nbsp;
                    in order to display a list of contributors.<br />
                    <br />
                    To view this page, click the "Continue" button.
                </div>

                <div className="consent">
                    <PrimaryButton
                            text="Continue"
                            onClick={() => {
                                setConsented(true);
                            }}
                        />
                </div>
            </>}

            {consented === true && <>
                <Stack>
                    <Separator alignContent="start">Contributors</Separator>
                    <Text>
                        This project exists thanks to all the people who contribute.
                    </Text>
                    <Text>
                        <Link href="https://github.com/Chinachu/Mirakurun/graphs/contributors" target="_blank"><img src="https://opencollective.com/Mirakurun/contributors.svg?width=890&button=false" /></Link>
                    </Text>
                </Stack>

                <Stack>
                    <Separator alignContent="start">Backers</Separator>
                    <Text>
                        Thank you to all our backers! 🙏
                        [<Link href="https://opencollective.com/Mirakurun#backer" target="_blank">Become a backer</Link>]
                    </Text>
                    <Text>
                        <Link href="https://opencollective.com/Mirakurun#backers" target="_blank"><img src="https://opencollective.com/Mirakurun/backers.svg?width=890" /></Link>
                    </Text>
                </Stack>

                <Stack>
                    <Separator alignContent="start">Sponsors</Separator>
                    <Text>
                        Support this project by becoming a sponsor. Your logo will show up here with a link to your website.
                        [<Link href="https://opencollective.com/Mirakurun#sponsor" target="_blank">Become a sponsor</Link>]
                    </Text>
                    <Text>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/0/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/0/avatar.svg" /></Link>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/1/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/1/avatar.svg" /></Link>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/2/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/2/avatar.svg" /></Link>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/3/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/3/avatar.svg" /></Link>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/4/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/4/avatar.svg" /></Link>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/5/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/5/avatar.svg" /></Link>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/6/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/6/avatar.svg" /></Link>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/7/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/7/avatar.svg" /></Link>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/8/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/8/avatar.svg" /></Link>
                        <Link href="https://opencollective.com/Mirakurun/sponsor/9/website" target="_blank"><img src="https://opencollective.com/Mirakurun/sponsor/9/avatar.svg" /></Link>
                    </Text>
                </Stack>
            </>}
        </Stack>
    );
};

export default HeartView;
